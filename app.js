// ===== AI Study Notebook - 主程式（含自動分頁） =====

// --- 載入 modern-screenshot（取代 html2canvas，修復 iPad 上 KaTeX 截圖排版問題） ---
import { domToBlob, domToPng } from 'https://cdn.jsdelivr.net/npm/modern-screenshot@4.5.5/dist/index.mjs';

// --- 取得頁面元素 ---
const editor = document.getElementById('editor');
const pagesContainer = document.getElementById('pages-container');
const measureBox = document.getElementById('measure-box');
const btnToggle = document.getElementById('btn-toggle');
const btnTheme = document.getElementById('btn-theme');
const modelSelect = document.getElementById('ai-model');
const toast = document.getElementById('toast');

// --- 狀態 ---
let isPreviewMode = false;
let currentModel = localStorage.getItem('aiModel') || 'claude';

// --- 每頁最大高度（px）---
// 大約等同 A4 紙的比例，在 iPad 上貼入筆記軟體時不會被縮太小
const PAGE_MAX_HEIGHT = 960;

// --- 設定 marked.js ---
marked.setOptions({
  breaks: true,  // 換行自動變成 <br>
  gfm: true      // GitHub 風格 Markdown
});

// --- 設定 Turndown：把 ChatGPT 網頁複製的 HTML 轉成乾淨 Markdown + LaTeX ---
const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
});

// 自訂規則：把 KaTeX 元素換回 $...$ / $$...$$
// 原始 LaTeX 由 KaTeX 內嵌的 <annotation encoding="application/x-tex"> 取得，
// 比起靠 regex 猜分隔符可靠得多
turndownService.addRule('katex', {
  filter: function (node) {
    return node.nodeName === 'SPAN'
      && node.classList
      && node.classList.contains('katex')
      && !node.classList.contains('katex-display'); // 區塊外層交給下一個規則處理
  },
  replacement: function (content, node) {
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation) return content;
    const latex = annotation.textContent.trim();
    const isDisplay = node.closest('.katex-display') !== null;
    return isDisplay ? '\n\n$$' + latex + '$$\n\n' : '$' + latex + '$';
  }
});

// 區塊公式外層 .katex-display：避免內外兩層都觸發
turndownService.addRule('katex-display-wrapper', {
  filter: function (node) {
    return node.nodeName === 'SPAN'
      && node.classList
      && node.classList.contains('katex-display');
  },
  replacement: function (content) {
    return content; // 內層 .katex 已輸出 $$...$$
  }
});

// ============================================================
// 核心功能 1：LaTeX 保護 + Markdown 渲染（產出 HTML 字串）
// ============================================================

/**
 * 把原始文字轉成渲染好的 HTML 字串
 * 會保護 LaTeX 不被 marked.js 破壞
 */
function renderToHTML(rawText) {
  // 依照使用者選擇的 AI 模型套用對應的 LaTeX 前處理
  const normalizedText = normalizeMathSyntax(rawText, currentModel);
  const mathBlocks = [];

  // 步驟 1：抽出 LaTeX，用佔位符取代
  let protectedText = normalizedText.replace(/\$\$([\s\S]+?)\$\$/g, function (match, latex) {
    const index = mathBlocks.length;
    mathBlocks.push({ latex: escapeLatexPercent(latex), display: true });
    return '@@MATH_BLOCK_' + index + '@@';
  });

  protectedText = protectedText.replace(/\$([^\$\n]+?)\$/g, function (match, latex) {
    const index = mathBlocks.length;
    mathBlocks.push({ latex: escapeLatexPercent(latex), display: false });
    return '@@MATH_BLOCK_' + index + '@@';
  });

  // 步驟 2：用 marked 解析 Markdown
  let html = marked.parse(protectedText);

  // 步驟 3：把佔位符換回 LaTeX
  html = html.replace(/@@MATH_BLOCK_(\d+)@@/g, function (match, indexStr) {
    const index = parseInt(indexStr);
    const block = mathBlocks[index];
    if (block.display) {
      return '<div class="katex-display-wrapper">$$' + block.latex + '$$</div>';
    } else {
      return '$' + block.latex + '$';
    }
  });

  return html;
}

/**
 * 將不同 AI 常見輸出的數學語法統一：
 * 通用規則 (Claude / Gemini / ChatGPT 都套用)：
 *   1) \[ ... \] => $$ ... $$
 *   2) \( ... \) => $ ... $
 *   3) ```math ... ``` => $$ ... $$
 *
 * ChatGPT 額外規則：
 *   4) 清除公式中間的 ===== 雜訊
 *   5) 含 LaTeX 指令的裸 [ ... ] / ( ... ) 轉成 $$ / $
 */
function normalizeMathSyntax(text, model) {
  if (!text) return text;

  let normalized = text;

  // display math: \[ ... \]
  normalized = normalized.replace(/\\\[([\s\S]+?)\\\]/g, function (match, latex) {
    return '\n$$' + latex.trim() + '$$\n';
  });

  // inline math: \( ... \)
  normalized = normalized.replace(/\\\(([\s\S]+?)\\\)/g, function (match, latex) {
    return '$' + latex.trim() + '$';
  });

  // fenced math block: ```math ... ```
  normalized = normalized.replace(/```(?:math|latex)\s*([\s\S]+?)```/gi, function (match, latex) {
    return '\n$$' + latex.trim() + '$$\n';
  });

  // ChatGPT 專屬：清雜訊 + 轉裸括號
  if (model === 'chatgpt') {
    normalized = stripChatGPTNoise(normalized);
    normalized = convertChatGPTBrackets(normalized);
  }

  return normalized;
}

/**
 * 處理 ChatGPT 輸出裡常見的雜訊
 *
 * 雜訊類型 1：====== 視覺長等號
 *   - 在 [ ... ] 區塊「內」：換成 = (保留等號語意，公式可串成等式鏈)
 *   - 在 [ ... ] 區塊「外」：整行刪除 (避免被 marked.js 當成 H1 underline)
 *
 * 雜訊類型 2：# 誤加在 [ 前面 (例如「# [」)
 *   - ChatGPT 偶爾會把多行公式區塊的 [ 前面加上 # (大概是想當成段落分隔)，
 *     但 marked.js 會把它當成 H1 標題，[ 變成標題內容，
 *     導致 [ ... ] 整個區塊無法被偵測為顯示公式。
 *   - 處理：把 # / ## / ### 等開頭、後面只接 [ 的行，把 # 標記去掉
 */
function stripChatGPTNoise(text) {
  // 1. [ 前面誤加的 # 標題標記 → 拿掉
  text = text.replace(/^#+[ \t]+\[[ \t]*$/gm, '[');

  // 2a. ====== 在區塊內 → =
  text = text.replace(/(^[ \t]*\[[ \t]*\r?\n)([\s\S]+?)(\r?\n[ \t]*\][ \t]*$)/gm, function (match, open, body, close) {
    const fixed = body.replace(/^={3,}[ \t]*$/gm, '=');
    return open + fixed + close;
  });

  // 2b. ====== 在區塊外 → 整行刪除
  text = text.replace(/^={3,}\s*$/gm, '');

  return text;
}

/**
 * 把 ChatGPT 用裸括號包起來的數學式轉成 KaTeX 可識別的 $$ / $
 *
 * ChatGPT 顯示公式的特徵格式：
 *   [
 *   公式內容
 *   ]
 * (即 [ 和 ] 各自獨佔一行) — 無論內容有沒有 LaTeX 指令，都當顯示公式處理
 *
 * 對於同一行的 [ ... ]，為了不破壞 markdown 連結參考、清單等，
 * 仍保留啟發式判斷：需含 LaTeX 特徵 (反斜線指令 / _{ / ^{ ) 才轉換
 *
 * 重要：規則 1 轉好的數學區塊必須先用佔位符藏起來，
 * 否則規則 2 會把區塊內部的 ( ... ) 又改成 $ ... $，造成 $$ 內塞 $ 的巢狀錯誤。
 */
function convertChatGPTBrackets(text) {
  const hasLatexPattern = /\\[a-zA-Z]+|[_^]\{/;
  const stashed = [];

  function stash(latex) {
    const idx = stashed.length;
    stashed.push('\n$$' + latex.trim() + '$$\n');
    return '@@CGT_MATH_' + idx + '@@';
  }

  // 規則 1a：跨行的 [ ... ] 區塊 → 暫存為佔位符
  // [ 和 ] 各自獨佔一行；中間任意內容；一律視為顯示公式
  text = text.replace(/^[ \t]*\[[ \t]*\r?\n([\s\S]+?)\r?\n[ \t]*\][ \t]*$/gm, function (match, inner) {
    return stash(inner);
  });

  // 規則 1b：同一行的 [ ... ] → 須含 LaTeX 特徵才轉換 (避免誤判 markdown)
  text = text.replace(/^[ \t]*\[[ \t]*([^\n\[\]]+?)[ \t]*\][ \t]*$/gm, function (match, inner) {
    return hasLatexPattern.test(inner) ? stash(inner) : match;
  });

  // 規則 2：行內 ( ... ) 含 LaTeX 特徵 → $ ... $
  // 此時上面藏起來的數學區塊已變成 @@CGT_MATH_n@@ 佔位符，不會被誤傷
  text = text.replace(/\(([^()\n]+?)\)/g, function (match, inner) {
    return hasLatexPattern.test(inner) ? '$' + inner.trim() + '$' : match;
  });

  // 還原佔位符
  text = text.replace(/@@CGT_MATH_(\d+)@@/g, function (match, idxStr) {
    return stashed[parseInt(idxStr)];
  });

  return text;
}

/**
 * 把 LaTeX 內未跳脫的 % 自動補成 \%
 *
 * 為什麼需要：在 LaTeX/KaTeX 規則裡 % 是註解符號，從 % 到行尾都會被忽略。
 * AI 輸出像 95.6% 這種百分比時常常忘記跳脫，結果 \boxed{...} 的右括號被吃掉、
 * 整個公式渲染失敗（紅字）。
 *
 * 規則：只在 % 前面「不是反斜線」時補跳脫，避免把已經正確的 \% 變成 \\%
 */
function escapeLatexPercent(latex) {
  return latex.replace(/(^|[^\\])%/g, '$1\\%');
}

/**
 * 對一個 DOM 元素執行 KaTeX 渲染
 */
function renderKaTeX(element) {
  renderMathInElement(element, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false }
    ],
    throwOnError: false
  });
}

// ============================================================
// 核心功能 2：自動分頁（DOM Splitting）
// ============================================================

/**
 * 自動分頁邏輯：
 *   1. 先把渲染好的 HTML 放進隱藏的測量區
 *   2. 用 KaTeX 渲染數學公式（這樣才能正確測量高度）
 *   3. 逐一檢查每個頂層元素的高度
 *   4. 如果加上去會超過頁面高度限制，就開新的一頁
 *   5. 絕對不會把一個元素從中間切斷
 *
 * 回傳：一個陣列，每個元素是一頁的 DOM 節點陣列
 */
function paginateContent(html) {
  // 把 HTML 放進測量區，讓瀏覽器計算實際高度
  measureBox.innerHTML = html;
  renderKaTeX(measureBox);

  // 取得所有頂層子元素
  const children = Array.from(measureBox.children);

  // 分頁結果：每一頁是一個 DOM 節點陣列
  const pages = [];
  let currentPage = [];
  let currentHeight = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // 取得元素的完整高度（包含 margin）
    const style = window.getComputedStyle(child);
    const marginTop = parseFloat(style.marginTop) || 0;
    const marginBottom = parseFloat(style.marginBottom) || 0;
    const childHeight = child.offsetHeight + marginTop + marginBottom;

    if (currentPage.length > 0 && currentHeight + childHeight > PAGE_MAX_HEIGHT) {
      // 超過頁面高度限制 → 把目前這頁存起來，開新頁
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }

    // 把這個元素加入目前這頁
    currentPage.push(child);
    currentHeight += childHeight;
  }

  // 最後一頁
  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  return pages;
}

/**
 * 建立分頁卡片 UI
 * 每張卡片包含：頁碼標籤 + 複製按鈕 + 內容區
 */
function buildPageCards(pages) {
  pagesContainer.innerHTML = '';

  for (let i = 0; i < pages.length; i++) {
    const pageNodes = pages[i];

    // --- 卡片外框 ---
    const card = document.createElement('div');
    card.className = 'page-card';

    // --- 卡片標頭：頁碼 + 複製按鈕 ---
    const header = document.createElement('div');
    header.className = 'page-header';

    const label = document.createElement('span');
    label.className = 'page-label';
    label.textContent = 'Page ' + (i + 1) + ' / ' + pages.length;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-success btn-sm';
    copyBtn.textContent = '複製這頁';
    copyBtn.setAttribute('data-page', i);
    copyBtn.addEventListener('click', function () {
      copyPageAsImage(i);
    });

    header.appendChild(label);
    header.appendChild(copyBtn);

    // --- 卡片內容區 ---
    const content = document.createElement('div');
    content.className = 'page-content';
    content.setAttribute('id', 'page-content-' + i);

    // 把這一頁的所有 DOM 節點搬進去
    for (let j = 0; j < pageNodes.length; j++) {
      content.appendChild(pageNodes[j].cloneNode(true));
    }

    // 重新渲染這一頁的 KaTeX（因為 cloneNode 不會帶 KaTeX 的渲染狀態）
    renderKaTeX(content);

    card.appendChild(header);
    card.appendChild(content);
    pagesContainer.appendChild(card);
  }
}

// ============================================================
// 核心功能 3：切換 預覽 / 編輯 模式
// ============================================================

function togglePreview() {
  if (!isPreviewMode) {
    // 切換到預覽模式
    const rawText = editor.value.trim();

    if (rawText === '') {
      pagesContainer.innerHTML = '<p style="color:#94a3b8; padding: 24px;">還沒有內容，請先貼上 Markdown / LaTeX 文字。</p>';
    } else {
      // 渲染 → 分頁 → 建立卡片
      const html = renderToHTML(rawText);
      const pages = paginateContent(html);
      buildPageCards(pages);
    }

    editor.classList.add('hidden');
    pagesContainer.classList.remove('hidden');
    btnToggle.textContent = '編輯';
  } else {
    // 切換回編輯模式
    editor.classList.remove('hidden');
    pagesContainer.classList.add('hidden');
    btnToggle.textContent = '預覽';
  }

  isPreviewMode = !isPreviewMode;
}

// ============================================================
// 核心功能 4：複製單頁為圖片
// ============================================================

async function copyPageAsImage(pageIndex) {
  const content = document.getElementById('page-content-' + pageIndex);
  if (!content) return;

  try {
    // 等待 KaTeX 字型完全載入
    await document.fonts.ready;

    // 用裝置實際像素比縮放，iPad 為 2x 或 3x
    var scale = window.devicePixelRatio || 2;

    // Safari 需要在使用者手勢當下直接傳 Promise<Blob> 給 ClipboardItem
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var blobPromise = domToBlob(content, {
      scale: scale,
      backgroundColor: isDark ? '#1e293b' : '#ffffff',
      style: {
        overflow: 'visible'
      }
    });

    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blobPromise
      })
    ]);

    showToast('Page ' + (pageIndex + 1) + ' 已複製到剪貼簿!');
  } catch (err) {
    console.error('複製失敗:', err);

    // 備援：下載圖片
    try {
      var dataUrl = await domToPng(content, {
        scale: window.devicePixelRatio || 2,
        backgroundColor: isDark ? '#1e293b' : '#ffffff'
      });
      var link = document.createElement('a');
      link.download = 'ai-note-page-' + (pageIndex + 1) + '.png';
      link.href = dataUrl;
      link.click();
      showToast('剪貼簿不可用，已改為下載圖片');
    } catch (downloadErr) {
      alert('複製失敗！請確認是否使用 HTTPS 連線。\n錯誤訊息：' + err.message);
    }
  }
}

// ============================================================
// 輔助功能：Toast 提示
// ============================================================

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 1500);
}

// ============================================================
// 初始化：綁定按鈕事件
// ============================================================

btnToggle.addEventListener('click', togglePreview);

// ===== ChatGPT 專用：貼上時改抓 HTML 取得精確 LaTeX =====
editor.addEventListener('paste', function (e) {
  if (currentModel !== 'chatgpt') return;

  const html = e.clipboardData && e.clipboardData.getData('text/html');
  if (!html) return; // 沒 HTML 就維持預設純文字貼上

  // 沒偵測到 KaTeX 結構就不攔截 (例如從筆記軟體貼純文字)
  if (!/class="[^"]*\bkatex\b/.test(html)) return;

  e.preventDefault();
  const markdown = turndownService.turndown(html);

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.substring(0, start);
  const after = editor.value.substring(end);
  editor.value = before + markdown + after;

  const newPos = start + markdown.length;
  editor.setSelectionRange(newPos, newPos);

  showToast('已用 HTML 模式貼上（公式準確度更高）');
});

// ===== AI 模型切換 =====

modelSelect.value = currentModel;
modelSelect.addEventListener('change', function () {
  currentModel = modelSelect.value;
  localStorage.setItem('aiModel', currentModel);
  // 如果目前在預覽模式,自動重新渲染讓使用者馬上看到效果
  if (isPreviewMode) {
    isPreviewMode = false;
    togglePreview();
  }
});

// ===== 深色 / 淺色模式切換 =====

const savedTheme = localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  btnTheme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

btnTheme.addEventListener('click', function () {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('theme', next);
});
