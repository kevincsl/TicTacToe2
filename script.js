/**
 * script.js  井字遊戲客戶端主邏輯
 * ====================================
 * 負責：
 *   1. 連線 Socket.io 伺服器（線上模式）
 *   2. 管理五個畫面的切換（暱稱  模式選擇  公開大廳 / 等待 / 遊戲）
 *   3. 即時接收與發送 Socket 事件（建立房間、加入房間、落子等）
 *   4. 根據伺服器廣播更新棋盤 UI、回合指示、勝負結果
 *   5. 本機 AI 對戰模式（含 Minimax 演算法，支援簡單/困難兩種難度）
 */

// ===== Socket.io 連線 =====
// io() 會自動連線到提供此頁面的同一伺服器（由 Express 提供）
const socket = io();

// =====================================================
// ===== 玩家本地狀態（僅前端使用，不送伺服器）=====
// =====================================================
const local = {
  /** 本玩家的棋子標記：'X' 或 'O'，由伺服器在線上遊戲開始時分配；AI 模式固定為 'X' */
  playerMark: null,

  /** 目前所在的房間代碼（4 碼英數字），建立/加入房間後設定，僅線上模式使用 */
  roomCode: null,

  /** 是否輪到本玩家落子：防止在對手回合或 AI 思考中點擊棋盤 */
  isMyTurn: false,

  /** 玩家在暱稱畫面輸入的名稱，用於建立/加入房間時傳送給伺服器 */
  myName: '',

  /**
   * 目前的對戰模式：
   *   'ai'     - 本機 AI 對戰（完全本地，不使用 Socket.io）
   *   'online' - 線上多人對奕（使用 Socket.io）
   *   null     - 尚未選擇模式
   */
  gameMode: null,
};

// =====================================================
// ===== AI 對戰模式狀態（本地遊戲，不與伺服器通訊）=====
// =====================================================
const aiGame = {
  /** 棋盤狀態陣列：9 格，每格為 'X'、'O' 或空字串 '' */
  board: Array(9).fill(''),

  /**
   * AI 難度：
   *   'easy' - 簡單：AI 從空格中隨機選一格落子
   *   'hard' - 困難：AI 使用 Minimax 演算法找理論最佳位置（不可能被擊敗）
   */
  difficulty: 'hard',

  /** 遊戲是否已結束（勝利或平局），防止已結束時繼續落子 */
  isOver: false,
};

/**
 * WIN_LINES：所有可能的獲勝連線（共 8 條）
 * 棋盤格子索引視覺對應：
 *   0 | 1 | 2
 *   ---------
 *   3 | 4 | 5
 *   ---------
 *   6 | 7 | 8
 */
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // 三橫排
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // 三直行
  [0, 4, 8], [2, 4, 6],             // 兩條對角線
];

// =====================================================
// ===== DOM 元素快取（避免重複查詢，提升效能）=====
// =====================================================

/**
 * screens：各畫面的 <section> 元素
 * JS 透過 showScreen(name) 切換 .hidden class 來控制顯示
 */
const screens = {
  name:        document.getElementById('screenName'),        // 畫面 1：輸入暱稱
  mode:        document.getElementById('screenMode'),        // 畫面 2：選擇對戰模式（新增）
  publicLobby: document.getElementById('screenPublicLobby'), // 畫面 3：公開大廳（房間列表）
  waiting:     document.getElementById('screenWaiting'),     // 畫面 4：等待對手加入
  game:        document.getElementById('screenGame'),        // 畫面 5：遊戲進行中
};

// --- 暱稱輸入畫面元素 ---
const nameInput     = document.getElementById('nameInput');     // 暱稱文字輸入框
const nameError     = document.getElementById('nameError');     // 暱稱錯誤提示文字
const btnEnterLobby = document.getElementById('btnEnterLobby'); // 「繼續」按鈕

// --- 模式選擇畫面元素 ---
const btnAIEasy = document.getElementById('btnAIEasy');  // 「AI 對戰（簡單）」模式按鈕
const btnAIHard = document.getElementById('btnAIHard');  // 「AI 對戰（困難）」模式按鈕
const btnOnline = document.getElementById('btnOnline');  // 「線上多人對奕」模式按鈕

// --- 公開大廳畫面元素 ---
const myNameChip    = document.getElementById('myNameChip');    // 顯示自己暱稱的 pill 標籤
const btnCreateRoom = document.getElementById('btnCreateRoom'); // 「建立房間」按鈕
const roomListEl    = document.getElementById('roomList');      // 房間卡片列表容器
const emptyStateEl  = document.getElementById('emptyState');    // 無房間時的空狀態提示
const btnBackToMode = document.getElementById('btnBackToMode'); // 「 返回」回到模式選擇按鈕

// --- 等待對手畫面元素 ---
const btnCancelWait = document.getElementById('btnCancelWait'); // 「取消並回大廳」按鈕
const displayCode   = document.getElementById('displayRoomCode'); // 顯示房間代碼的大字區塊

// --- 遊戲畫面元素 ---
const statusEl    = document.getElementById('status');       // 回合狀態文字（「輪到你了」等）
const cellEls     = [...document.querySelectorAll('.cell')]; // 9 個棋格按鈕（NodeList 轉 Array）
const badgeX      = document.getElementById('badgeX');       // X 玩家標示卡（含高亮效果）
const badgeO      = document.getElementById('badgeO');       // O 玩家標示卡
const labelX      = document.getElementById('labelX');       // X 玩家名稱文字
const labelO      = document.getElementById('labelO');       // O 玩家名稱文字
const gameActions = document.getElementById('gameActions');  // 遊戲結束後的操作按鈕區
const btnRematch  = document.getElementById('btnRematch');   // 「再來一局」按鈕
const btnBackLobby = document.getElementById('btnBackLobby'); // 「回大廳」按鈕

// --- Toast 通知 ---
const toastEl = document.getElementById('toast'); // 底部浮現的即時提示訊息

// =====================================================
// ===== 工具函式
// =====================================================

/**
 * showScreen(name)
 * 切換顯示的畫面。迭代 screens 物件，只讓指定的畫面移除 .hidden，
 * 其餘全部加上 .hidden（display: none）
 * @param {string} name - screens 物件的 key（'name'|'mode'|'publicLobby'|'waiting'|'game'）
 */
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    // key !== name 時條件為 true  加上 hidden；反之移除 hidden
    el.classList.toggle('hidden', key !== name);
  });
}

/**
 * showToast(msg, duration)
 * 在頁面底部彈出一個短暫的通知訊息，超過 duration 毫秒後自動淡出消失。
 * 重複呼叫時會清除上一個計時器，確保計時重新開始。
 * @param {string} msg       - 要顯示的訊息文字
 * @param {number} duration  - 顯示持續毫秒數（預設 3500ms）
 */
let toastTimer; // 模組層級計時器 ID，用於 clearTimeout 防止疊加
function showToast(msg, duration = 3500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden', 'fade-out'); // 先確保可見
  toastTimer = setTimeout(() => {
    toastEl.classList.add('fade-out');             // 觸發 CSS 淡出動畫
    setTimeout(() => toastEl.classList.add('hidden'), 400); // 動畫結束後完全隱藏
  }, duration);
}

/**
 * escapeHtml(str)
 * 將使用者輸入的暱稱中的 HTML 特殊字元轉義，防止 XSS 注入攻擊。
 * 在 createRoomCard() 使用 innerHTML 前必須先對使用者輸入做此處理。
 * @param {string} str - 原始字串
 * @returns {string}   - 已轉義的安全字串
 */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// =====================================================
// ===== 畫面 1：暱稱輸入
// =====================================================

// 點擊「繼續」或在輸入框按 Enter 皆可觸發
btnEnterLobby.addEventListener('click', enterLobby);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterLobby(); });

/**
 * enterLobby()
 * 驗證暱稱不為空後，將暱稱存入 local.myName，
 * 切換到模式選擇畫面（由玩家決定 AI 對戰或線上多人模式）。
 */
function enterLobby() {
  const name = nameInput.value.trim(); // 去除頭尾空白
  if (!name) {
    // 暱稱為空：顯示錯誤提示，阻止進入下一步
    nameError.textContent = '請輸入暱稱才能繼續。';
    return;
  }
  nameError.textContent = '';    // 清除舊錯誤訊息
  local.myName = name;           // 儲存暱稱供後續建立/加入房間使用
  myNameChip.textContent = name; // 更新大廳頁面的暱稱顯示
  showScreen('mode');            // 前往模式選擇畫面
}

// =====================================================
// ===== 畫面 2：對戰模式選擇
// =====================================================

/**
 * btnAIEasy 點擊：啟動簡單 AI 對戰
 * 簡單模式 = AI 每次從空格中隨機選一格落子，適合初學者練習
 */
btnAIEasy.addEventListener('click', () => startAIGame('easy'));

/**
 * btnAIHard 點擊：啟動困難 AI 對戰
 * 困難模式 = AI 使用 Minimax 演算法，每步都選理論最佳位置（不可能被擊敗）
 */
btnAIHard.addEventListener('click', () => startAIGame('hard'));

/**
 * btnOnline 點擊：進入線上多人公開大廳
 * 通知伺服器此玩家進入大廳，伺服器會回傳當前房間列表（room_list 事件）
 */
btnOnline.addEventListener('click', () => {
  local.gameMode = 'online'; // 標記為線上模式
  socket.emit('enter_lobby', { name: local.myName }); // 告知伺服器
  showScreen('publicLobby');
});

// =====================================================
// ===== AI 對戰核心邏輯（Minimax 演算法）
// =====================================================

/**
 * checkWinnerLocal(board)
 * 在本地棋盤陣列上檢查是否有玩家獲勝或平局。
 * 此函式供 AI 演算法和落子後結果判斷使用（完全不依賴伺服器）。
 *
 * @param {string[]} board - 9 格棋盤陣列
 * @returns {{ winner: string|null, line: number[]|null } | null}
 *   - 有人獲勝：{ winner: 'X'|'O', line: [a, b, c] }（三個獲勝格索引）
 *   - 平局（棋盤已滿）：{ winner: null, line: null }
 *   - 遊戲繼續（仍有空格且無人獲勝）：null
 */
function checkWinnerLocal(board) {
  // 逐一檢查 8 條獲勝連線
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] }; // 找到獲勝連線
    }
  }
  // 棋盤已滿且無人獲勝  平局
  if (board.every(cell => cell !== '')) return { winner: null, line: null };
  // 還有空格且無人獲勝  遊戲繼續
  return null;
}

/**
 * minimax(board, depth, isMaximizing)
 * 遞迴 Minimax 演算法：為每個可能的棋盤狀態計算分數，
 * 讓 AI 選擇理論上對自己最有利的落子位置。
 *
 * 評分原則：
 *   AI (O) 獲勝    正分（越快獲勝分數越高：10 - depth）
 *   人類 (X) 獲勝  負分（越快落敗分數越低：depth - 10）
 *   平局            0
 *
 * AI 為「最大化玩家」（Maximizer），嘗試找最高分。
 * 人類為「最小化玩家」（Minimizer），嘗試找最低分（對 AI 最不利）。
 *
 * @param {string[]} board       - 目前棋盤陣列（臨時修改後會回溯還原）
 * @param {number}   depth       - 遞迴深度（越深代表越遠的未來局面，用於偏好快速獲勝）
 * @param {boolean}  isMaximizing - true = AI 回合（O）；false = 玩家回合（X）
 * @returns {number} - 此棋盤狀態的評估分數
 */
function minimax(board, depth, isMaximizing) {
  // 終止條件：有勝負或平局結果
  const result = checkWinnerLocal(board);
  if (result !== null) {
    if (result.winner === 'O') return 10 - depth; // AI 獲勝，越快越好（分數越大）
    if (result.winner === 'X') return depth - 10; // 玩家獲勝，越快越壞（分數越小）
    return 0;                                      // 平局
  }

  if (isMaximizing) {
    // AI 回合：嘗試每個空格，選對 AI 最有利（分數最高）的位置
    let best = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === '') {
        board[i] = 'O';                                        // 試探性落子
        best = Math.max(best, minimax(board, depth + 1, false)); // 遞迴計算
        board[i] = '';                                         // 回溯（恢復原狀）
      }
    }
    return best;
  } else {
    // 玩家回合：嘗試每個空格，找對 AI 最不利（分數最低）的局面
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === '') {
        board[i] = 'X';
        best = Math.min(best, minimax(board, depth + 1, true));
        board[i] = '';
      }
    }
    return best;
  }
}

/**
 * getAIMove(board, difficulty)
 * 根據難度選擇 AI 的落子位置。
 *
 * @param {string[]} board      - 目前棋盤陣列（傳入副本，避免污染原始狀態）
 * @param {string}   difficulty - 'easy'（隨機）| 'hard'（Minimax 最佳策略）
 * @returns {number} - AI 應落子的格子索引（0~8）
 */
function getAIMove(board, difficulty) {
  // 收集所有空格索引
  const emptyIndices = board.reduce((acc, v, i) => (v === '' ? [...acc, i] : acc), []);

  if (difficulty === 'easy') {
    // 簡單模式：從所有空格中隨機挑一格
    return emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  }

  // 困難模式：使用 Minimax 演算法遍歷所有空格，找到分數最高的位置
  let bestScore = -Infinity;
  let bestIndex = -1;
  for (const i of emptyIndices) {
    board[i] = 'O';                            // 試探性落子
    const score = minimax(board, 0, false);    // 計算此位置未來的最優分數
    board[i] = '';                             // 回溯
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i; // 記錄分數最高的格子
    }
  }
  return bestIndex;
}

/**
 * startAIGame(difficulty)
 * 初始化並開始一局本地 AI 對戰。
 *   - 重置本地棋盤狀態與 AI 難度
 *   - 設定玩家標記（玩家 = X 先手，AI = O 後手）
 *   - 設定玩家標示列的名稱文字
 *   - 渲染空棋盤 UI，切換到遊戲畫面
 *
 * @param {string} difficulty - 'easy' | 'hard'
 */
function startAIGame(difficulty) {
  local.gameMode   = 'ai';  // 標記為 AI 本地模式
  local.playerMark = 'X';   // 玩家固定為 X（先手）
  local.isMyTurn   = true;  // 玩家先落子

  // 重置 AI 遊戲狀態
  aiGame.board      = Array(9).fill('');
  aiGame.difficulty = difficulty;
  aiGame.isOver     = false;

  // 設定玩家標示列文字
  labelX.textContent = (local.myName || '玩家') + ' (你)'; // X = 玩家
  labelO.textContent = difficulty === 'hard'
    ? ' AI（困難）'
    : ' AI（簡單）'; // O = AI

  resetBoardUI(Array(9).fill('')); // 清空棋盤 UI
  updateTurnUI('X');               // 顯示「輪到你了」
  showScreen('game');              // 切換到遊戲畫面
}

/**
 * handleAIGameEnd(result)
 * 處理 AI 對戰結束（勝利或平局）：
 *   - 標記遊戲已結束（防止繼續點擊落子）
 *   - 高亮獲勝連線格子（勝利時）
 *   - 更新狀態文字與 CSS class
 *   - 顯示操作按鈕（再來一局 / 回主選單）
 *
 * @param {{ winner: string|null, line: number[]|null }} result
 *   - winner: 'X'（玩家勝）| 'O'（AI 勝）| null（平局）
 *   - line:   獲勝的三格索引陣列；平局時為 null
 */
function handleAIGameEnd(result) {
  aiGame.isOver = true; // 遊戲結束，阻止後續落子

  if (result.winner === 'X') {
    // 玩家獲勝
    result.line.forEach(i => cellEls[i].classList.add('winner')); // 金色高亮
    statusEl.textContent = ' 你贏了！';
    statusEl.className   = 'status winner';
  } else if (result.winner === 'O') {
    // AI 獲勝
    result.line.forEach(i => cellEls[i].classList.add('winner'));
    statusEl.textContent = ' AI 獲勝！再接再厲！';
    statusEl.className   = 'status winner';
  } else {
    // 平局
    statusEl.textContent = ' 平局！勢均力敵！';
    statusEl.className   = 'status draw';
  }

  endRound(); // 鎖定棋盤、顯示操作按鈕
}

// =====================================================
// ===== 畫面 3：公開大廳
// =====================================================

// 「 返回」：回到模式選擇畫面
btnBackToMode.addEventListener('click', () => {
  showScreen('mode');
});

// 點擊「建立房間」：傳送暱稱給伺服器，伺服器會建立房間並回傳 room_created
btnCreateRoom.addEventListener('click', () => {
  socket.emit('create_room', { name: local.myName });
});

/**
 * Socket 事件：room_list
 * 伺服器在以下情況廣播此事件給所有連線的客戶端：
 *   - 玩家進入大廳（enter_lobby）
 *   - 有新房間被建立
 *   - 房間被填滿（遊戲開始）、或房主斷線
 * @param {Array<{code: string, hostName: string, createdAt: number}>} rooms
 *   - 目前所有公開等待中的房間陣列
 */
socket.on('room_list', (rooms) => {
  // 若公開大廳畫面目前不可見，忽略此事件（不需更新 DOM）
  if (screens.publicLobby.classList.contains('hidden')) return;

  roomListEl.innerHTML = ''; // 清除舊的房間卡片

  if (rooms.length === 0) {
    // 沒有房間：顯示空狀態提示
    emptyStateEl.classList.remove('hidden');
    return;
  }
  emptyStateEl.classList.add('hidden'); // 有房間：隱藏空狀態提示

  // 將每個房間資料渲染為可點擊卡片並插入列表
  rooms.forEach(room => {
    const card = createRoomCard(room);
    roomListEl.appendChild(card);
  });
});

/**
 * createRoomCard({ code, hostName, createdAt })
 * 動態建立一張房間卡片 DOM 元素。
 * 卡片包含：遊戲圖示、建立者名稱、等待時間、房間代碼、等待 Badge。
 * 點擊或按 Enter/Space 時發送 join_room 事件給伺服器。
 *
 * @param {string} code       - 房間代碼（4 碼）
 * @param {string} hostName   - 房主暱稱
 * @param {number} createdAt  - 房間建立時間戳（Unix ms）
 * @returns {HTMLElement}     - 組裝完成的 <article> 元素
 */
function createRoomCard({ code, hostName, createdAt }) {
  const card = document.createElement('article');
  card.className = 'room-card';
  card.tabIndex = 0;                               // 允許鍵盤 Tab 聚焦
  card.setAttribute('role', 'button');             // 告訴輔助技術這是可點擊的按鈕
  card.setAttribute('aria-label', `加入 ${hostName} 的房間`);

  // 計算此房間已等待多少時間
  const waitSec  = Math.floor((Date.now() - createdAt) / 1000);
  const waitText = waitSec < 60
    ? `等待 ${waitSec} 秒`
    : `等待 ${Math.floor(waitSec / 60)} 分鐘`;

  // 注意：hostName 必須先 escapeHtml 轉義，避免 XSS
  card.innerHTML = `
    <div class="room-card-icon"></div>
    <div class="room-card-info">
      <div class="room-card-host">${escapeHtml(hostName)}</div>
      <div class="room-card-meta">${waitText}前建立</div>
    </div>
    <div class="room-card-code">${code}</div>
    <div class="waiting-badge">
      <span class="pulse-dot"></span>等待中
    </div>
  `;

  // 加入房間的函式（點擊或鍵盤觸發）
  const joinFn = () => socket.emit('join_room', { code, name: local.myName });
  card.addEventListener('click', joinFn);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // 防止 Space 鍵捲動頁面
      joinFn();
    }
  });

  return card;
}

// =====================================================
// ===== 畫面 4：等待對手
// =====================================================

// 「取消並回大廳」：斷線重連以清除伺服器端舊的 socket.data，再進入大廳
btnCancelWait.addEventListener('click', () => {
  socket.disconnect();
  socket.connect();
  local.roomCode   = null;
  local.playerMark = null;
  socket.emit('enter_lobby', { name: local.myName });
  showScreen('publicLobby');
});

// 點擊房間代碼：複製到剪貼簿（適合分享給朋友）
displayCode.addEventListener('click', () => {
  navigator.clipboard?.writeText(local.roomCode)
    .then(() => showToast(' 代碼已複製！'));
});

// =====================================================
// ===== Socket 事件處理（線上模式專用）
// =====================================================

/**
 * room_created
 * 伺服器成功建立房間後回傳給建立者（X 玩家）
 * @param {string} code - 新建立的 4 碼房間代碼
 */
socket.on('room_created', ({ code }) => {
  local.roomCode   = code;  // 記錄房間代碼（供複製功能使用）
  local.playerMark = 'X';   // 建立者固定為 X
  displayCode.textContent = code; // 在等待畫面顯示代碼
  showScreen('waiting');
});

/**
 * join_error
 * 加入房間失敗時伺服器回傳的錯誤訊息（房間不存在、已滿等）
 * @param {string} message - 錯誤說明文字
 */
socket.on('join_error', ({ message }) => {
  showToast(` ${message}`);
});

/**
 * game_start
 * 兩位玩家都就位後，伺服器廣播給房間內雙方，代表遊戲正式開始。
 * @param {string}   playerMark    - 本玩家的棋子（'X' 或 'O'）
 * @param {string[]} board         - 初始棋盤狀態（9 格，全為空字串）
 * @param {string}   currentPlayer - 先手玩家（固定為 'X'）
 * @param {string}   opponentName  - 對手的暱稱
 * @param {string}   myName        - 伺服器確認的自己暱稱
 */
socket.on('game_start', ({ playerMark, board, currentPlayer, opponentName, myName }) => {
  local.playerMark = playerMark;
  local.gameMode   = 'online';                         // 標記為線上模式
  local.isMyTurn   = (currentPlayer === playerMark); // 判斷自己是否為先手

  // 根據本玩家是 X 還是 O 來設定玩家名稱標示
  const xName = (playerMark === 'X') ? (myName || local.myName) : (opponentName || '對手');
  const oName = (playerMark === 'O') ? (myName || local.myName) : (opponentName || '對手');
  labelX.textContent = xName + (playerMark === 'X' ? ' (你)' : ''); // 加上「(你)」標記自己
  labelO.textContent = oName + (playerMark === 'O' ? ' (你)' : '');

  resetBoardUI(board);          // 重置棋盤（應對再來一局）
  updateTurnUI(currentPlayer);  // 更新回合指示器
  showScreen('game');
});

/**
 * game_update
 * 每次有玩家落子後，伺服器廣播給房間雙方的棋盤更新事件。
 * 包含落子結果（繼續、獲勝、平局）。
 *
 * @param {string[]} board         - 更新後的完整棋盤陣列
 * @param {number}   index         - 此次落子的格子索引（0~8）
 * @param {string}   player        - 剛才落子的玩家（'X' 或 'O'）
 * @param {string}   currentPlayer - 下一回合的玩家（result='continue' 時才有）
 * @param {string}   result        - 結果類型：'continue' | 'win' | 'draw'
 * @param {number[]} winLine       - 獲勝的三個格子索引（result='win' 時才有）
 * @param {string}   winner        - 獲勝玩家標記（result='win' 時才有）
 */
socket.on('game_update', ({ board, index, player, currentPlayer, result, winLine, winner }) => {
  renderCell(index, player); // 在棋盤上顯示剛落下的棋子

  if (result === 'win') {
    // 高亮三個獲勝格子
    winLine.forEach(i => cellEls[i].classList.add('winner'));
    const isWinner = (winner === local.playerMark);
    statusEl.textContent = isWinner ? ' 你贏了！' : ' 對手獲勝！';
    statusEl.className   = 'status winner';
    endRound(); // 鎖定棋盤、顯示操作按鈕
    return;
  }

  if (result === 'draw') {
    statusEl.textContent = ' 平局！';
    statusEl.className   = 'status draw';
    endRound();
    return;
  }

  // 遊戲繼續：更新本玩家的回合旗標並更新 UI
  local.isMyTurn = (currentPlayer === local.playerMark);
  updateTurnUI(currentPlayer);
});

/**
 * opponent_left
 * 對手斷線或離開房間時，伺服器通知另一方。
 * 此時鎖定棋盤並顯示回大廳按鈕（隱藏再來一局，因為對手已不存在）
 */
socket.on('opponent_left', () => {
  showToast(' 對手已離線，遊戲結束。', 5000);
  statusEl.textContent = '對手已離線';
  statusEl.className   = 'status draw';
  cellEls.forEach(c => { c.disabled = true; }); // 鎖定所有格子
  gameActions.classList.remove('hidden');
  btnRematch.classList.add('hidden'); // 對手不在了，隱藏再來一局
});

/**
 * rematch_requested
 * 對手按下「再來一局」後，伺服器通知另一方有人想再玩一局。
 * 顯示 Toast 提示，引導玩家按下自己的「再來一局」按鈕。
 */
socket.on('rematch_requested', () => {
  showToast(' 對手想再來一局，按「再來一局」確認！');
});

/**
 * rematch_start
 * 雙方都同意再來一局後，伺服器廣播此事件，重置棋盤開始新一局。
 * @param {string[]} board         - 全空的初始棋盤
 * @param {string}   currentPlayer - 先手玩家（固定 'X'）
 */
socket.on('rematch_start', ({ board, currentPlayer }) => {
  gameActions.classList.add('hidden');    // 隱藏結束按鈕區
  btnRematch.classList.remove('hidden'); // 確保再來一局按鈕可見（下一局結束後再用）
  resetBoardUI(board);
  local.isMyTurn = (currentPlayer === local.playerMark);
  updateTurnUI(currentPlayer);
});

// =====================================================
// ===== 遊戲畫面：按鈕事件
// =====================================================

/**
 * 「再來一局」按鈕：
 *   AI 模式   直接在本地重新開始一局（維持相同難度，不需 Socket.io）
 *   線上模式  發送投票給伺服器，需雙方都同意才重置
 */
btnRematch.addEventListener('click', () => {
  if (local.gameMode === 'ai') {
    // AI 模式：直接重置，維持目前難度
    startAIGame(aiGame.difficulty);
    return;
  }
  // 線上模式：送出再來一局投票
  socket.emit('request_rematch');
  btnRematch.disabled    = true;             // 防止重複點擊
  btnRematch.textContent = '等待對手確認'; // 視覺回饋
});

/**
 * 「回大廳」按鈕：
 *   AI 模式   返回模式選擇畫面
 *   線上模式  斷線重連以重置伺服器狀態，再重新進入公開大廳
 */
btnBackLobby.addEventListener('click', () => {
  if (local.gameMode === 'ai') {
    // AI 模式：直接回模式選擇，不需 Socket 操作
    local.gameMode = null;
    showScreen('mode');
    return;
  }
  // 線上模式：斷線重連以清除伺服器端 socket.data（roomCode、mark 等）
  socket.disconnect();
  socket.connect();
  local.playerMark = null;
  local.roomCode   = null;
  local.gameMode   = null;
  socket.emit('enter_lobby', { name: local.myName });
  myNameChip.textContent = local.myName; // 更新大廳暱稱標籤
  showScreen('publicLobby');
});

// =====================================================
// ===== 棋盤格子：事件綁定
// =====================================================

// 為 9 個棋格各自綁定點擊與鍵盤事件
cellEls.forEach(cell => {
  cell.addEventListener('click', onCellClick);
  cell.addEventListener('keydown', e => {
    // Enter 或 Space 視為點擊（無障礙支援）
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // 防止 Space 觸發頁面捲動
      onCellClick({ currentTarget: cell });
    }
  });
});

/**
 * onCellClick({ currentTarget })
 * 棋格點擊處理（AI 模式與線上模式共用入口）：
 *
 * AI 模式流程：
 *   1. 非玩家回合或遊戲已結束  直接忽略
 *   2. 格子已有棋子  忽略
 *   3. 玩家落子（X），立即渲染格子
 *   4. 檢查玩家是否獲勝或造成平局  是則結束遊戲
 *   5. 切換 UI 到 AI 回合，延遲 500ms 後執行 AI 落子（O）
 *   6. 檢查 AI 是否獲勝或造成平局  是則結束遊戲
 *   7. 否則切換回玩家回合
 *
 * 線上模式流程：
 *   1. 非本玩家回合  直接忽略
 *   2. 格子已有棋子  忽略
 *   3. 發送 make_move 給伺服器（伺服器驗證後廣播 game_update）
 *   - 客戶端不自行修改棋盤狀態，所有更新來自伺服器廣播，防止作弊
 */
function onCellClick({ currentTarget }) {
  const index = Number(currentTarget.dataset.index); // 從 data-index 取得格子索引

  // ===== AI 模式 =====
  if (local.gameMode === 'ai') {
    if (!local.isMyTurn || aiGame.isOver) return; // 非玩家回合或遊戲已結束，忽略
    if (aiGame.board[index] !== '') return;        // 格子已有棋子，忽略

    // 玩家落子（X）
    aiGame.board[index] = 'X';
    renderCell(index, 'X');

    // 檢查玩家落子後是否有結果
    const playerResult = checkWinnerLocal(aiGame.board);
    if (playerResult !== null) {
      handleAIGameEnd(playerResult); // 有結果（贏或平局） 結束遊戲
      return;
    }

    // 切換到 AI 回合，更新 UI 顯示「AI 思考中」
    local.isMyTurn = false;
    updateTurnUI('O');

    // AI 延遲 500ms 落子，模擬思考感，讓玩家看清楚自己的落子
    setTimeout(() => {
      const aiIndex = getAIMove([...aiGame.board], aiGame.difficulty); // 傳入副本避免污染
      aiGame.board[aiIndex] = 'O';
      renderCell(aiIndex, 'O');

      // 檢查 AI 落子後是否有結果
      const aiResult = checkWinnerLocal(aiGame.board);
      if (aiResult !== null) {
        handleAIGameEnd(aiResult); // 有結果  結束遊戲
        return;
      }

      // 遊戲繼續，換回玩家回合
      local.isMyTurn = true;
      updateTurnUI('X');
    }, 500);

    return; // 提前返回，不執行下方線上模式邏輯
  }

  // ===== 線上模式 =====
  if (!local.isMyTurn) return; // 不是自己的回合，忽略
  if (currentTarget.disabled || currentTarget.textContent !== '') return; // 已有棋子，忽略
  socket.emit('make_move', { index }); // 送出落子請求，等待伺服器廣播確認
}

// =====================================================
// ===== UI 輔助函式
// =====================================================

/**
 * renderCell(index, player)
 * 在指定格子上顯示棋子標記，並加上出現動畫 (.marked)。
 * 落子後立即停用格子，防止重複點擊。
 *
 * @param {number} index  - 格子索引（0~8）
 * @param {string} player - 棋子標記（'X' 或 'O'）
 */
function renderCell(index, player) {
  const cell = cellEls[index];
  cell.textContent = player;
  cell.classList.add(player.toLowerCase(), 'marked'); // 'x' 或 'o' class 決定顏色
  cell.disabled = true;                               // 停用，不可再次點擊
  cell.setAttribute('aria-label', `格子 ${index + 1}：${player}`); // 更新無障礙標籤
}

/**
 * updateTurnUI(currentPlayer)
 * 根據當前回合玩家更新以下 UI：
 *   - 玩家標示卡（badgeX / badgeO）高亮邊框
 *   - 狀態文字（AI 模式：「 輪到你了」或「 AI 思考中」；線上模式類似）
 *   - 棋格游標樣式（非本回合時顯示 not-allowed）
 *
 * @param {string} currentPlayer - 當前應落子的玩家（'X' 或 'O'）
 */
function updateTurnUI(currentPlayer) {
  const isMyTurn = (currentPlayer === local.playerMark);

  // 更新玩家標示卡的高亮邊框（active-x 或 active-o）
  badgeX.className = 'player-badge' + (currentPlayer === 'X' ? ' active-x' : '');
  badgeO.className = 'player-badge' + (currentPlayer === 'O' ? ' active-o' : '');

  // 更新狀態文字與 CSS class（影響文字顏色）
  const turnClass    = currentPlayer === 'X' ? 'x-turn' : 'o-turn';
  statusEl.className = `status ${turnClass}${isMyTurn ? ' my-turn' : ''}`;

  if (local.gameMode === 'ai') {
    // AI 模式：AI 回合時顯示「思考中」
    statusEl.textContent = isMyTurn
      ? ` 輪到你了（${currentPlayer}）`
      : ' AI 思考中';
  } else {
    // 線上模式：對手回合時顯示等待訊息
    statusEl.textContent = isMyTurn
      ? ` 輪到你了（${currentPlayer}）`
      : ` 等待對手（${currentPlayer}）落子`;
  }

  // 對未落子的格子套用/移除「禁止游標」樣式
  cellEls.forEach(cell => {
    if (!cell.disabled) cell.classList.toggle('not-your-turn', !isMyTurn);
  });
}

/**
 * resetBoardUI(board)
 * 依據棋盤陣列（通常是全空）重置棋盤 UI 狀態。
 * 在遊戲開始或再來一局時呼叫。
 *
 * @param {string[]} board - 9 格棋盤陣列，空字串代表未落子
 */
function resetBoardUI(board) {
  cellEls.forEach((cell, i) => {
    cell.textContent = board[i] || '';   // 空格清空文字
    cell.disabled    = board[i] !== '';  // 已有棋子則停用
    // 若有棋子，補上對應的顏色 class（'x' 或 'o'）及出現動畫 class
    cell.className   = 'cell' + (board[i] ? ` ${board[i].toLowerCase()} marked` : '');
    cell.setAttribute('aria-label', `格子 ${i + 1}${board[i] ? '：' + board[i] : ''}`);
  });

  // 重置遊戲結束操作區：隱藏按鈕區、恢復再來一局按鈕狀態
  gameActions.classList.add('hidden');
  btnRematch.disabled    = false;
  btnRematch.textContent = '再來一局 ';
  btnRematch.classList.remove('hidden');

  // 清除玩家標示卡的高亮狀態
  badgeX.className = 'player-badge';
  badgeO.className = 'player-badge';
}

/**
 * endRound()
 * 遊戲回合結束（獲勝或平局）時呼叫：
 *   - 將 isMyTurn 設為 false，防止繼續落子
 *   - 停用所有棋格
 *   - 顯示「再來一局」和「回大廳」按鈕
 */
function endRound() {
  local.isMyTurn = false;
  cellEls.forEach(c => { c.disabled = true; });
  gameActions.classList.remove('hidden');
}
