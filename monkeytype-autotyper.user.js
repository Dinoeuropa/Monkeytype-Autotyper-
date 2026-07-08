// ==UserScript==
// @name         Monkeytype Auto Typer
// @version      3.1.0
// @description  Automatically types Monkeytype tests at a configurable WPM
// @match        https://monkeytype.com/*
// @match        https://www.monkeytype.com/*
// @match        https://dev.monkeytype.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.__mtAutotyperLoaded) {
    console.log("[Monkeytype Auto Typer] Already running. Use mtAutotyper.toggle() or refresh.");
    return;
  }
  window.__mtAutotyperLoaded = true;
  document.getElementById("mt-autotyper-panel")?.remove();

  const STORAGE_KEY = "mtAutotyperSettings";
  const MAX_WPM = 99999;
  const MIN_WPM = 50;
  const TICK_FLOOR_MS = 0;
  const MAX_CHARS_PER_TICK = 48;
  const DEFAULTS = { enabled: false, targetWpm: 200, humanize: false };

  const PLACEHOLDER_TEXT = new Set([
    "unknown", "unk", "?", "？", "□", "▯", "￭", "\uFFFD",
  ]);

  function splitChars(str) {
    const out = [];
    for (const ch of String(str).normalize("NFC")) out.push(ch);
    return out;
  }

  const CHAR_EQUIV = [
    new Set(["'", "\u2018", "\u2019", "\u02BC", "\u05F3", "\u02BB", "\u1FBD"]),
    new Set(['"', "\u201C", "\u201D", "\u201E", "\u00AB", "\u00BB"]),
    new Set(["\u2013", "\u2014", "-", "\u2010"]),
    new Set([",", "\u201A"]),
    new Set(["\u0451", "\u0435", "e"]),
  ];

  function charsEqual(a, b) {
    if (a === b) return true;
    for (const set of CHAR_EQUIV) {
      if (set.has(a) && set.has(b)) return true;
    }
    return false;
  }

  function isPlaceholderChar(ch) {
    if (!ch || ch === "_") return true;
    if (PLACEHOLDER_TEXT.has(ch)) return true;
    if (PLACEHOLDER_TEXT.has(ch.toLowerCase())) return true;
    return false;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("typingAutotyperSettings");
      return { ...DEFAULTS, ...JSON.parse(raw || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  let settings = loadSettings();
  let running = false;
  let charIndex = 0;
  let queue = [];
  let timerId = null;
  let langProfile = null;
  const wordCache = new Map();
  let wordsObserver = null;
  let lastQueuedWordIndex = -1;
  let nextCharAt = 0;

  function getWordsInput() {
    return document.querySelector("#wordsInput, #testInput");
  }

  function getWordsEl() {
    return document.querySelector("#words, .pageTest #words");
  }

  function looksLikeWordList(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return false;
    return arr.slice(0, 8).every((w) => typeof w === "string" && w.length > 0 && w.length < 80);
  }

  function captureWordsList(list) {
    if (looksLikeWordList(list)) {
      window.__mtWordsList = list;
      list.forEach((w, i) => wordCache.set(i, String(w)));
      return true;
    }
    return false;
  }

  function tryCaptureFromPayload(data) {
    if (!data || typeof data !== "object") return;
    if (captureWordsList(data.words)) return;
    for (const val of Object.values(data)) {
      if (captureWordsList(val)) return;
    }
  }

  function installFetchHook() {
    if (window.__mtFetchHooked) return;
    window.__mtFetchHooked = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await originalFetch(...args);
      try {
        tryCaptureFromPayload(await res.clone().json());
      } catch (_) {}
      return res;
    };
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          tryCaptureFromPayload(JSON.parse(this.responseText));
        } catch (_) {}
      });
      return originalSend.apply(this, args);
    };
  }

  function isWordDomPristine(wordEl) {
    return !wordEl.querySelector("letter.incorrect, letter.extra");
  }

  function decodeHtmlText(html) {
    if (!html) return "";
    const el = document.createElement("textarea");
    el.innerHTML = html;
    return (el.value || "").normalize("NFC");
  }

  function decodeLetterChar(letterEl) {
    if (letterEl.classList.contains("tabChar")) return "\t";
    if (letterEl.classList.contains("nlChar")) return "\n";
    if (letterEl.classList.contains("invisible")) return null;
    if (letterEl.querySelector("i.fas, i.fa")) return null;
    let text = (letterEl.textContent || "").normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    if (isPlaceholderChar(text) || /^_+$/.test(text)) {
      const fromHtml = decodeHtmlText(letterEl.innerHTML.replace(/<[^>]+>/g, "")).trim();
      if (fromHtml && !isPlaceholderChar(fromHtml)) text = fromHtml;
      else return null;
    }
    return text || null;
  }

  function extractWordCharsFromDOM(wordEl) {
    if (!isWordDomPristine(wordEl)) return [];
    const chars = [];
    for (const letterEl of wordEl.querySelectorAll(":scope > letter, :scope > .letter")) {
      if (letterEl.classList.contains("incorrect") || letterEl.classList.contains("extra")) continue;
      const piece = decodeLetterChar(letterEl);
      if (!piece) continue;
      for (const ch of splitChars(piece)) {
        if (!isPlaceholderChar(ch)) chars.push(ch);
      }
    }
    return chars;
  }

  function cacheWordElement(wordEl) {
    const idxAttr = wordEl.getAttribute("data-wordindex");
    const idx = idxAttr !== null && idxAttr !== "" ? parseInt(idxAttr, 10) : NaN;
    if (Number.isNaN(idx) || wordCache.has(idx)) return;
    if (!isWordDomPristine(wordEl)) return;
    const chars = extractWordCharsFromDOM(wordEl);
    if (!chars.length) return;
    const text = chars.join("");
    if (!isPlaceholderChar(text) && text.toLowerCase() !== "unknown") {
      wordCache.set(idx, text);
    }
  }

  function cacheAllVisibleWords() {
    const wordsEl = getWordsEl();
    if (!wordsEl) return;
    wordsEl.querySelectorAll(".word").forEach(cacheWordElement);
  }

  function installWordCacheObserver() {
    if (wordsObserver) return;
    const wordsEl = getWordsEl();
    if (!wordsEl) return;
    cacheAllVisibleWords();
    wordsObserver = new MutationObserver(() => {
      if (running) appendWordsToQueue();
    });
    wordsObserver.observe(wordsEl, { childList: true, subtree: true });
  }

  function hookTestWordsList() {
    installFetchHook();
    installWordCacheObserver();
    cacheAllVisibleWords();
    return window.__mtWordsList || null;
  }

  function getMonkeytypeLanguage() {
    try {
      if (typeof Config !== "undefined" && Config.language) return String(Config.language);
    } catch (_) {}
    for (const sel of [
      ".config .group.language .text",
      "#testConfig .language .text",
      ".pageConfig .language .text",
    ]) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        return el.textContent.trim().toLowerCase().replace(/\s+/g, "_");
      }
    }
    return null;
  }

  function detectLangProfile() {
    const lang = (getMonkeytypeLanguage() || "").toLowerCase();
    const wordsEl = getWordsEl();
    const rtl = wordsEl?.classList.contains("rightToLeftTest") ?? false;
    const nospace =
      lang.includes("nospace") ||
      document.querySelector(".pageTest.nospace, #words.nospace") !== null;
    const cjk = /^(chinese|japanese|korean)|chinese|japanese|korean|cjk/.test(lang);
    return { lang: lang || (rtl ? "rtl" : "auto"), rtl, cjk, nospace };
  }

  function msPerChar(wpm) {
    const cps = (Math.max(1, wpm) * 5) / 60;
    return 1000 / cps;
  }

  function usesWordSpaces() {
    return !langProfile?.nospace;
  }

  function getActiveWordIndex() {
    const active = document.querySelector("#words .word.active");
    if (!active) return -1;
    const attr = active.getAttribute("data-wordindex");
    if (attr !== null && attr !== "") return parseInt(attr, 10);
    const wordsEl = getWordsEl();
    if (!wordsEl) return -1;
    const children = [...wordsEl.children].filter((el) => el.classList.contains("word"));
    return children.indexOf(active);
  }

  function getWordCharsByIndex(wordIndex, wordEl, allowDom) {
    if (allowDom && wordEl && isWordDomPristine(wordEl)) {
      return extractWordCharsFromDOM(wordEl);
    }
    if (!running) {
      if (wordCache.has(wordIndex)) return splitChars(wordCache.get(wordIndex));
      const list = window.__mtWordsList;
      if (list && list[wordIndex] !== undefined) {
        const text = String(list[wordIndex]);
        wordCache.set(wordIndex, text);
        return splitChars(text);
      }
    }
    return [];
  }

  function getUpcomingWords(maxWords = 100, allowDom = true) {
    const wordsEl = getWordsEl();
    const list = window.__mtWordsList;
    let startWordIndex = getActiveWordIndex();
    const result = [];
    if (startWordIndex < 0) startWordIndex = 0;

    if (wordsEl) {
      const children = [...wordsEl.children].filter((el) => el.classList.contains("word"));
      const activeDomIdx = children.findIndex((el) => el.classList.contains("active"));
      const domStart = activeDomIdx >= 0 ? activeDomIdx : 0;
      for (let i = domStart; i < children.length && result.length < maxWords; i++) {
        const attr = children[i].getAttribute("data-wordindex");
        const wordIndex = attr !== null && attr !== "" ? parseInt(attr, 10) : i;
        const chars = getWordCharsByIndex(wordIndex, children[i], allowDom);
        if (chars.length > 0) result.push(chars);
      }
      if (result.length > 0) return result;
    }

    if (list?.length) {
      for (let wi = startWordIndex; wi < list.length && result.length < maxWords; wi++) {
        const chars = getWordCharsByIndex(wi, null, false);
        if (chars.length > 0) result.push(chars);
      }
    }
    return result;
  }

  function getCurrentTyped() {
    const el = getWordsInput();
    if (!el) return [];
    const raw = el.value.startsWith(" ") ? el.value.slice(1) : el.value;
    return splitChars(raw.normalize("NFC"));
  }

  function syncCharIndexFromInput() {
    const typed = getCurrentTyped();
    let idx = 0;
    while (idx < typed.length && idx < queue.length && charsEqual(typed[idx], queue[idx])) idx++;
    charIndex = idx;
  }

  function appendWordCharsToQueue(chars) {
    if (!chars.length) return;
    if (queue.length > 0 && usesWordSpaces() && queue[queue.length - 1] !== " ") {
      queue.push(" ");
    }
    for (const ch of chars) queue.push(ch);
  }

  function appendWordsToQueue() {
    const wordsEl = getWordsEl();
    if (!wordsEl) return;
    const activeIdx = getActiveWordIndex();
    const start = Math.max(activeIdx, lastQueuedWordIndex + 1);

    for (const child of wordsEl.querySelectorAll(".word")) {
      const attr = child.getAttribute("data-wordindex");
      const wi = attr !== null && attr !== "" ? parseInt(attr, 10) : -1;
      if (wi < start || wi <= lastQueuedWordIndex) continue;
      if (!isWordDomPristine(child)) continue;
      const chars = getWordCharsByIndex(wi, child, true);
      if (!chars.length) continue;
      appendWordCharsToQueue(chars);
      lastQueuedWordIndex = wi;
    }
  }

  function resyncQueue() {
    const words = getUpcomingWords(150, true);
    const newQueue = [];
    for (let i = 0; i < words.length; i++) {
      for (const ch of words[i]) newQueue.push(ch);
      if (i < words.length - 1 && usesWordSpaces()) newQueue.push(" ");
    }
    if (!newQueue.length) return;
    syncCharIndexFromInput();
    const typed = getCurrentTyped();
    let idx = 0;
    while (idx < typed.length && idx < newQueue.length && charsEqual(typed[idx], newQueue[idx])) idx++;
    queue = newQueue;
    charIndex = idx;
  }

  function buildQueue(fresh = false) {
    langProfile = detectLangProfile();
    hookTestWordsList();

    if (fresh) {
      queue = [];
      lastQueuedWordIndex = -1;
      const wordList = getUpcomingWords(120, true);
      const activeIdx = Math.max(0, getActiveWordIndex());
      for (let i = 0; i < wordList.length; i++) {
        for (const ch of wordList[i]) queue.push(ch);
        if (i < wordList.length - 1 && usesWordSpaces()) queue.push(" ");
      }
      if (wordList.length > 0) lastQueuedWordIndex = activeIdx + wordList.length - 1;
    } else {
      appendWordsToQueue();
    }
    syncCharIndexFromInput();
  }

  function dispatchInput(el, inputType, data) {
    const before = new InputEvent("beforeinput", {
      inputType, data: data ?? null, bubbles: true, cancelable: true,
    });
    el.dispatchEvent(before);
    if (before.defaultPrevented) return false;
    const cur = el.value.startsWith(" ") ? el.value.slice(1) : el.value;
    if (inputType === "insertLineBreak") el.value = " " + cur + "\n";
    else if (data) el.value = " " + cur + data;
    const len = el.value.length;
    if (typeof el.setSelectionRange === "function") el.setSelectionRange(len, len);
    el.dispatchEvent(new InputEvent("input", { inputType, data: data ?? null, bubbles: true }));
    return true;
  }

  function typeText(text) {
    const el = getWordsInput();
    if (!el || !text) return false;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    if (text === "\n") {
      if (document.execCommand("insertText", false, "\n")) return true;
      return dispatchInput(el, "insertLineBreak", null);
    }
    if (document.execCommand("insertText", false, text)) return true;
    return dispatchInput(el, "insertText", text);
  }

  function typeChar(char) {
    return typeText(char);
  }

  function typeBatch(text) {
    if (!text) return true;
    if (text.includes("\n")) {
      for (const ch of text) {
        if (!typeChar(ch)) return false;
      }
      return true;
    }
    return typeText(text);
  }

  function isTestActive() {
    const wordsEl = getWordsEl();
    if (!wordsEl || wordsEl.offsetParent === null) return false;
    return wordsEl.querySelector(".word.active, .word") !== null;
  }

  function isTestFinished() {
    const result = document.querySelector("#result");
    if (result && !result.classList.contains("hidden")) return true;
    if (!isTestActive() && result) {
      const rect = result.getBoundingClientRect();
      return rect.height > 40 && rect.width > 40;
    }
    return false;
  }

  function scheduleNext() {
    if (!running || !settings.enabled) return;

    if (isTestFinished()) {
      settings.enabled = false;
      saveSettings();
      syncToggleUi();
      stop("test finished");
      return;
    }

    if (charIndex >= queue.length) {
      appendWordsToQueue();
      if (queue.length === 0) {
        timerId = setTimeout(scheduleNext, 80);
        return;
      }
    }
    if (charIndex >= queue.length) {
      timerId = setTimeout(scheduleNext, 80);
      return;
    }

    const msChar = msPerChar(settings.targetWpm);
    const now = performance.now();
    if (nextCharAt <= 0) nextCharAt = now;

    if (settings.humanize) {
      syncCharIndexFromInput();
      const delay = msChar * (0.85 + Math.random() * 0.35);
      typeChar(queue[charIndex++]);
      nextCharAt = now + delay;
      timerId = setTimeout(scheduleNext, delay);
      return;
    }

    let batch = "";
    while (charIndex < queue.length && nextCharAt <= now && batch.length < MAX_CHARS_PER_TICK) {
      batch += queue[charIndex++];
      nextCharAt += msChar;
    }
    if (!batch.length) {
      const wait = Math.max(0, nextCharAt - performance.now());
      timerId = setTimeout(scheduleNext, wait || TICK_FLOOR_MS);
      return;
    }
    typeBatch(batch);
    const wait = Math.max(0, nextCharAt - performance.now());
    timerId = setTimeout(scheduleNext, wait || TICK_FLOOR_MS);
  }

  function resetForNewRun() {
    wordCache.clear();
    lastQueuedWordIndex = -1;
    charIndex = 0;
    queue = [];
    nextCharAt = 0;
  }

  function focusTest() {
    const el = getWordsInput();
    if (!el) {
      log("ERROR: Open monkeytype.com and press Tab to start a test first.");
      return false;
    }
    getWordsEl()?.click();
    el.focus({ preventScroll: true });
    log("Focused. Press Tab once if words are not active.");
    return true;
  }

  function start() {
    if (running) return;
    if (!getWordsInput()) {
      log("ERROR: #wordsInput missing. Press Tab to start a test.");
      return;
    }
    focusTest();
    resetForNewRun();
    buildQueue(true);

    if (queue.length === 0) {
      log('No words yet. Press Tab, then "Prepare test", then Start.');
      return;
    }

    const preview = queue.slice(charIndex, charIndex + 40).join("");
    const bad = queue.filter((c) => isPlaceholderChar(c) || c.toLowerCase() === "unknown");
    if (bad.length > 0) {
      log("WARNING: Bad chars in queue. Press Tab, then Prepare, then Start.");
      return;
    }

    running = true;
    updateStatus();
    scheduleNext();
    log(`Typing ${settings.targetWpm} WPM | ${queue.length} chars | ${preview.slice(0, 20)}…`);
  }

  function stop(reason) {
    running = false;
    nextCharAt = 0;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    updateStatus();
    log(reason ? `Stopped (${reason})` : "Stopped");
  }

  function toggle() {
    settings.enabled = !settings.enabled;
    saveSettings();
    syncToggleUi();
    settings.enabled ? start() : stop("manual");
  }

  function log(msg) {
    console.log(`[Monkeytype Auto Typer] ${msg}`);
    const status = document.getElementById("mt-autotyper-status");
    if (status) status.textContent = msg;
  }

  function debug() {
    langProfile = detectLangProfile();
    hookTestWordsList();
    buildQueue(true);
    const words = getUpcomingWords(3);
    const sample = words.map((w) => w.join(""));

    console.log({
      wordsInput: !!getWordsInput(),
      wordsEl: !!getWordsEl(),
      testActive: isTestActive(),
      language: langProfile,
      internalWordCount: window.__mtWordsList?.length ?? 0,
      cachedWords: wordCache.size,
      activeWordIndex: getActiveWordIndex(),
      upcomingWords: sample,
      typed: getCurrentTyped().join(""),
      queuePreview: queue.slice(charIndex, charIndex + 24).join(""),
      charIndex,
    });

    if (sample.some((w) => /unknown|□/i.test(w))) {
      log("Placeholder text detected — refresh and paste script before starting.");
    } else if (words.length) {
      log(`OK: ${sample.join(" | ")} (${wordCache.size} cached)`);
    } else {
      log("No words — press Tab to start a test first.");
    }
  }

  function createPanel() {
    if (document.getElementById("mt-autotyper-panel")) return;

    const panel = document.createElement("div");
    panel.id = "mt-autotyper-panel";
    panel.innerHTML = `
      <style>
        #mt-autotyper-panel {
          position: fixed; bottom: 16px; right: 16px; z-index: 99999;
          width: 280px; padding: 14px; border-radius: 12px;
          background: rgba(20, 20, 24, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #e8e8e8;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 8px 32px rgba(0,0,0,0.35);
        }
        #mt-autotyper-panel h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
        #mt-autotyper-panel label {
          display: flex; justify-content: space-between; align-items: center;
          margin: 8px 0; gap: 8px;
        }
        #mt-autotyper-panel input[type="number"] {
          width: 72px; padding: 4px 6px; border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(0,0,0,0.3); color: inherit;
        }
        #mt-autotyper-panel button {
          width: 100%; margin-top: 6px; padding: 8px; border: none;
          border-radius: 8px; background: #e2b714; color: #111;
          font-weight: 600; cursor: pointer;
        }
        #mt-autotyper-panel button.secondary {
          background: rgba(255,255,255,0.12); color: #e8e8e8;
        }
        #mt-autotyper-panel button.off {
          background: rgba(255,255,255,0.15); color: #e8e8e8;
        }
        #mt-autotyper-status { margin-top: 8px; font-size: 11px; opacity: 0.85; min-height: 2.5em; }
        #mt-autotyper-hint { margin-top: 6px; font-size: 11px; opacity: 0.55; line-height: 1.35; }
        #mt-lang-tag {
          display: inline-block; margin-left: 6px; padding: 2px 6px;
          border-radius: 4px; background: rgba(255,255,255,0.1); font-size: 10px;
        }
      </style>
      <h3>Monkeytype Auto Typer <span id="mt-lang-tag">—</span></h3>
      <label>Target WPM <input id="mt-wpm" type="number" min="50" max="99999" step="50" /></label>
      <button class="secondary" id="mt-focus-btn">1. Prepare test</button>
      <button id="mt-toggle-btn">2. Start typing</button>
      <button class="secondary" id="mt-debug-btn">Check setup</button>
      <div id="mt-autotyper-status">Loaded — press Tab, then Prepare → Start</div>
      <div id="mt-autotyper-hint">Ctrl+Shift+M to toggle. Escape to stop.</div>
    `;

    document.body.appendChild(panel);
    document.getElementById("mt-wpm").value = settings.targetWpm;
    document.getElementById("mt-wpm").addEventListener("change", (e) => {
      settings.targetWpm = Math.min(MAX_WPM, Math.max(MIN_WPM, Number(e.target.value) || 200));
      e.target.value = settings.targetWpm;
      saveSettings();
    });
    document.getElementById("mt-focus-btn").addEventListener("click", focusTest);
    document.getElementById("mt-toggle-btn").addEventListener("click", toggle);
    document.getElementById("mt-debug-btn").addEventListener("click", debug);

    const tag = document.getElementById("mt-lang-tag");
    if (tag) tag.textContent = detectLangProfile().lang;

    syncToggleUi();
  }

  function syncToggleUi() {
    const btn = document.getElementById("mt-toggle-btn");
    if (!btn) return;
    btn.textContent = settings.enabled ? "Stop typing" : "2. Start typing";
    btn.classList.toggle("off", !settings.enabled);
    updateStatus();
  }

  function updateStatus() {
    const status = document.getElementById("mt-autotyper-status");
    if (!status) return;
    status.textContent = settings.enabled
      ? (running ? `Running ~${settings.targetWpm} WPM` : "Waiting for words (press Tab)")
      : "Ready — Tab → Prepare → Start";
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && settings.enabled) {
        settings.enabled = false;
        saveSettings();
        stop("escape");
        syncToggleUi();
      }
    },
    true
  );

  createPanel();
  hookTestWordsList();

  window.mtAutotyper = {
    start,
    stop,
    toggle,
    focusTest,
    debug,
    hookTestWordsList,
    setWpm(wpm) {
      settings.targetWpm = Math.min(MAX_WPM, Math.max(MIN_WPM, wpm));
      saveSettings();
      const input = document.getElementById("mt-wpm");
      if (input) input.value = settings.targetWpm;
    },
    get maxWpm() {
      return MAX_WPM;
    },
    getLanguage: () => detectLangProfile(),
  };

  if (!getWordsInput()) {
    log("WARNING: Open monkeytype.com, paste this script, press Tab to start a test.");
  } else {
    log(`Loaded (${detectLangProfile().lang}). Tab → Prepare → Start. Run mtAutotyper.debug()`);
  }
})();
