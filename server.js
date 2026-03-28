/**
 * server.js  井字遊戲 Node.js 後端
 * =====================================
 * 技術棧：Express（靜態檔案服務）+ Socket.io（WebSocket 即時通訊）
 *
 * 主要職責：
 *   1. 提供 index.html / style.css / script.js 等靜態檔案
 *   2. 管理「公開房間列表」，供大廳頁面即時展示
 *   3. 處理房間的建立、加入、落子、再來一局、斷線等遊戲事件
 *   4. 在伺服器端驗證落子合法性（防止客戶端作弊）
 *   5. 廣播遊戲狀態更新給房間內的兩位玩家
 */

const express  = require('express');       // HTTP 靜態檔案伺服器
const { createServer } = require('http');  // Node.js 原生 HTTP 模組
const { Server } = require('socket.io');  // WebSocket 即時通訊框架
const path     = require('path');          // 路徑處理工具（跨平台）

// ===== 建立 Express 應用與 HTTP 伺服器 =====
const app        = express();
const httpServer = createServer(app); // Socket.io 需要掛載在 HTTP 伺服器上

// ===== Socket.io 伺服器設定 =====
const io = new Server(httpServer, {
  cors: { origin: '*' }, // 開發階段允許所有來源；正式環境應限制網域
});

// ===== 靜態檔案服務 =====
// 將 __dirname（本檔案所在目錄）設為靜態根目錄
// 瀏覽器訪問 / 時會取得 index.html，/style.css 取得樣式等
app.use(express.static(path.join(__dirname)));

// =====================================================
// ===== 房間資料管理
// =====================================================

/**
 * rooms：所有進行中 / 等待中的房間集合
 * 資料結構：Map<roomCode: string, RoomState: object>
 *
 * RoomState 物件欄位說明：
 * {
 *   players:     [socketId_X, socketId_O | null]  // [0]=X玩家，[1]=O玩家（null=尚未加入）
 *   playerNames: [name_X, name_O | null]           // 對應的暱稱
 *   board:       string[9]                          // 棋盤，'' 表示空格，'X'/'O' 表示已落子
 *   currentPlayer: 'X' | 'O'                       // 目前輪到哪個玩家落子
 *   isGameOver:  boolean                            // 遊戲是否已結束（勝負或平局）
 *   isPublic:    boolean                            // true=在大廳列表顯示，false=已滿不顯示
 *   createdAt:   number                             // 建立時間戳（Unix ms），用於顯示等待時間
 *   rematchVotes?: Set<socketId>                    // 同意再來一局的玩家 ID 集合（遊戲結束後才有）
 * }
 */
const rooms = new Map();

/**
 * generateRoomCode()
 * 產生一個不重複的 4 碼大寫英數字房間代碼。
 * 排除容易混淆的字元（0/O、1/I）以提升可讀性。
 * 使用 do...while 確保代碼唯一（若碰撞則重新生成）。
 *
 * @returns {string} 4 碼房間代碼，例如 'K7MN'
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除 0/O/1/I 等混淆字元
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code)); // 碰撞時重新生成
  return code;
}

/**
 * createRoomState(hostSocketId, hostName)
 * 初始化一個新的房間狀態物件。
 * 房間建立時只有 X（房主）就位，O 玩家欄位為 null。
 *
 * @param {string} hostSocketId - 房主的 socket.id
 * @param {string} hostName     - 房主的暱稱
 * @returns {object} 初始房間狀態物件
 */
function createRoomState(hostSocketId, hostName) {
  return {
    players:       [hostSocketId, null], // [X玩家 socketId, O玩家 socketId（尚未加入）]
    playerNames:   [hostName, null],     // [X暱稱, O暱稱（尚未加入）]
    board:         Array(9).fill(''),    // 9 格空棋盤
    currentPlayer: 'X',                 // X 永遠先手
    isGameOver:    false,                // 遊戲尚未結束
    isPublic:      true,                 // 建立後立即公開在大廳
    createdAt:     Date.now(),           // 記錄建立時間，客戶端用於顯示「等待 X 秒」
  };
}

/**
 * getPublicRoomList()
 * 從 rooms Map 中篩選出所有「等待中（isPublic=true 且 O玩家為 null）」的房間，
 * 轉為輕量的陣列格式回傳給客戶端（不傳送 socketId 等敏感資訊）。
 * 依建立時間降序排列，讓最新的房間排最前面。
 *
 * @returns {Array<{code: string, hostName: string, createdAt: number}>}
 */
function getPublicRoomList() {
  const list = [];
  for (const [code, room] of rooms) {
    // 只列出公開且仍等待 O 玩家的房間
    if (room.isPublic && room.players[1] === null) {
      list.push({
        code,
        hostName:  room.playerNames[0],
        createdAt: room.createdAt,
      });
    }
  }
  // 最新建立的排最前（createdAt 越大越新）
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

/**
 * broadcastRoomList()
 * 向所有已連線的客戶端廣播最新的公開房間清單。
 * 在以下事件後呼叫：建立房間、加入房間（成功或失敗）、斷線。
 */
function broadcastRoomList() {
  io.emit('room_list', getPublicRoomList());
}

// =====================================================
// ===== 8 條勝利線判斷（伺服器端，防止客戶端作弊）
// =====================================================

/**
 * WIN_LINES：井字棋所有可能的獲勝組合（共 8 條）
 * - 3 列：[0,1,2] [3,4,5] [6,7,8]
 * - 3 欄：[0,3,6] [1,4,7] [2,5,8]
 * - 2 對角線：[0,4,8] [2,4,6]
 *
 * 棋盤索引對應：
 *   0 | 1 | 2
 *   ---------
 *   3 | 4 | 5
 *   ---------
 *   6 | 7 | 8
 */
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // 橫排（列）
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // 直排（欄）
  [0, 4, 8], [2, 4, 6],             // 對角線
];

/**
 * checkWinner(board)
 * 遍歷 8 條勝利線，判斷是否有玩家獲勝。
 * 若找到三格相同且非空，回傳該勝利線；否則回傳 null。
 *
 * @param {string[]} board - 9 格棋盤陣列
 * @returns {number[] | null} 獲勝的三個索引，或 null（無人獲勝）
 */
function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (
      board[a] !== '' &&           // 格子不為空
      board[a] === board[b] &&     // 三格相同
      board[b] === board[c]
    ) {
      return line; // 回傳獲勝的三個索引
    }
  }
  return null; // 無人獲勝
}

// =====================================================
// ===== Socket.io 連線事件處理
// =====================================================

io.on('connection', (socket) => {
  // 每位玩家連線時，socket.id 是唯一識別碼
  console.log(`[連線] socket.id=${socket.id}`);

  // ---------------------------------------------------
  // enter_lobby：玩家進入公開大廳
  // 記錄暱稱並回傳當前房間清單（只給這位玩家）
  // ---------------------------------------------------
  socket.on('enter_lobby', ({ name }) => {
    socket.data.playerName = name || '匿名玩家'; // 儲存暱稱供後續使用
    // 只回給這位玩家，不需廣播（其他人清單不變）
    socket.emit('room_list', getPublicRoomList());
  });

  // ---------------------------------------------------
  // create_room：玩家建立新的公開房間
  // 產生代碼、初始化房間、加入 Socket.io room、廣播清單
  // ---------------------------------------------------
  socket.on('create_room', ({ name } = {}) => {
    // 優先使用傳入的 name，其次用 enter_lobby 時儲存的 playerName
    const hostName = name || socket.data.playerName || '匿名玩家';
    socket.data.playerName = hostName; // 更新以確保一致

    const code = generateRoomCode();
    rooms.set(code, createRoomState(socket.id, hostName));

    socket.join(code);              // 加入 Socket.io 的 room（用於群播）
    socket.data.roomCode    = code; // 記錄此 socket 所在的房間
    socket.data.playerMark  = 'X';  // 建立者固定為 X

    // 只通知建立者（顯示等待畫面與代碼）
    socket.emit('room_created', { code, playerMark: 'X' });
    console.log(`[建立房間] code=${code}, host=${hostName}`);

    broadcastRoomList(); // 讓所有在大廳的人看到新房間
  });

  // ---------------------------------------------------
  // join_room：玩家點擊房間卡片或輸入代碼加入
  // 驗證後加入房間，通知雙方遊戲開始
  // ---------------------------------------------------
  socket.on('join_room', ({ code, name }) => {
    const room       = rooms.get(code);
    const joinerName = name || socket.data.playerName || '匿名玩家';
    socket.data.playerName = joinerName;

    // 房間不存在（可能已被刪除）
    if (!room) {
      socket.emit('join_error', { message: '找不到此房間，可能已被關閉。' });
      broadcastRoomList(); // 清單可能已過期，重新廣播
      return;
    }

    // 房間已滿（O 玩家位置已有人）
    if (room.players[1] !== null) {
      socket.emit('join_error', { message: '此房間已滿，請選擇其他房間或建立新房間。' });
      broadcastRoomList();
      return;
    }

    // ===== 合法加入：設定 O 玩家資訊 =====
    room.players[1]     = socket.id;   // 記錄 O 玩家的 socket.id
    room.playerNames[1] = joinerName;  // 記錄 O 玩家暱稱
    room.isPublic       = false;       // 房間已滿，從大廳列表移除

    socket.join(code);             // 加入 Socket.io room
    socket.data.roomCode   = code;
    socket.data.playerMark = 'O';

    // 通知 O 玩家（加入者）遊戲開始，含對手（X）暱稱
    socket.emit('game_start', {
      playerMark:   'O',
      board:        room.board,
      currentPlayer: room.currentPlayer,
      opponentName: room.playerNames[0], // 對手是 X（房主）
      myName:       joinerName,
    });

    // 通知 X 玩家（房主）遊戲開始，含對手（O）暱稱
    socket.to(code).emit('game_start', {
      playerMark:   'X',
      board:        room.board,
      currentPlayer: room.currentPlayer,
      opponentName: joinerName,          // 對手是 O（加入者）
      myName:       room.playerNames[0],
    });

    console.log(`[遊戲開始] 房間 ${code}：${room.playerNames[0]}(X) vs ${joinerName}(O)`);
    broadcastRoomList(); // 此房間已從大廳移除，更新清單
  });

  // ---------------------------------------------------
  // make_move：玩家落子
  // 伺服器端驗證合法性，再更新棋盤並廣播結果
  // ---------------------------------------------------
  socket.on('make_move', ({ index }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    // 多重合法性驗證（防止客戶端偽造請求）：
    if (
      !room                                        || // 房間不存在
      room.isGameOver                              || // 遊戲已結束
      room.currentPlayer !== socket.data.playerMark|| // 非此玩家的回合
      room.board[index]  !== ''                       // 格子已有棋子
    ) return;

    // ===== 合法落子：更新棋盤 =====
    room.board[index] = room.currentPlayer;

    // 勝負判斷
    const winLine = checkWinner(room.board);
    if (winLine) {
      room.isGameOver = true;
      // 廣播獲勝結果給房間內雙方
      io.to(code).emit('game_update', {
        board:  room.board,
        index,
        player: room.currentPlayer, // 剛落子的玩家即為獲勝者
        result: 'win',
        winLine,                    // 三個獲勝格子索引（供前端高亮）
        winner: room.currentPlayer,
      });
      return;
    }

    // 平局判斷：所有格子都已落子且無人獲勝
    if (room.board.every(cell => cell !== '')) {
      room.isGameOver = true;
      io.to(code).emit('game_update', {
        board:  room.board,
        index,
        player: room.currentPlayer,
        result: 'draw',
      });
      return;
    }

    // 遊戲繼續：切換回合玩家
    room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
    io.to(code).emit('game_update', {
      board:         room.board,
      index,
      player:        room.currentPlayer === 'X' ? 'O' : 'X', // 剛落子的（切換前）
      currentPlayer: room.currentPlayer,                       // 下一個落子的
      result:        'continue',
    });
  });

  // ---------------------------------------------------
  // request_rematch：玩家投票再來一局
  // 需要雙方都投票才重置遊戲；先投票者會通知對方
  // ---------------------------------------------------
  socket.on('request_rematch', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    // 初始化投票集合（遊戲結束後才建立）
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id); // 記錄此玩家已投票

    if (room.rematchVotes.size === 2) {
      // ===== 雙方都同意：重置房間狀態，開始新一局 =====
      room.board         = Array(9).fill('');
      room.currentPlayer = 'X';     // X 仍然先手
      room.isGameOver    = false;
      room.rematchVotes.clear();    // 清除投票，供下一次再戰使用

      io.to(code).emit('rematch_start', {
        board:         room.board,
        currentPlayer: room.currentPlayer,
      });
    } else {
      // ===== 只有一方投票：通知對方有人想再玩 =====
      socket.to(code).emit('rematch_requested');
    }
  });

  // ---------------------------------------------------
  // disconnect：玩家斷線
  // 通知同房間的另一方，並刪除房間、更新大廳列表
  // ---------------------------------------------------
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return; // 此玩家尚未進入任何房間，無需處理

    console.log(`[斷線] ${socket.data.playerName} (socket.id=${socket.id}), room=${code}`);

    const room = rooms.get(code);
    if (!room) return; // 房間已被提前刪除，無需重複處理

    // 通知房間內另一位玩家（若存在）對手已離開
    socket.to(code).emit('opponent_left');

    // 刪除房間（無論是等待中還是進行中）
    rooms.delete(code);

    // 更新大廳清單（若此房間原本公開，現在需從列表移除）
    broadcastRoomList();
  });
});

// =====================================================
// ===== 啟動 HTTP 伺服器
// =====================================================

/** 監聽 PORT 環境變數（雲端部署用），本機開發預設 3000 */
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(` 伺服器運行中：http://localhost:${PORT}`);
});
