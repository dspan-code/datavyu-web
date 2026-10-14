/* ui/video.js —— 视频播放器 + 走带控制器
 *
 * 关键设计：**时间基准是 store.time（毫秒整数），不是 video.currentTime**。
 * 原因：HTML5 的 currentTime 是浮点秒、且 seek 不保证帧精确；Datavyu 的时间码是整毫秒，
 * 所以这里所有「跳转」都先算出目标毫秒，再交给浏览器 seek，并用 seeked 事件回读校正。
 *
 * 逐帧公式（与原版一致）：frame = floor(time / (1000/fps))；上一帧/下一帧就是 frame ± 1。
 */

(function () {
  const T = globalThis.DVY.timeutil;

  function mount(store, els) {
    const video = els.video;
    let objectUrl = null;
    let seeking = false;
    let pendingSeekMs = null; // seek 在途时的目标毫秒；期间忽略 video 报回来的中间值
    let rafId = 0;

    /* ---------------------------------------------------------- 载入媒体 */

    function setMedia(src, name, { revokePrev = true } = {}) {
      if (revokePrev && objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      video.src = src;
      video.load();
      store.mediaName = name;
      els.mediaName.textContent = name || "未加载";
      els.videoEmpty.hidden = true;
      store.emit("play", { media: true });
    }

    function loadFile(file) {
      if (!file) return;
      if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|ogv|ogg|mkv|avi)$/i.test(file.name)) {
        store.emit("msg", { text: `不是视频文件：${file.name}`, kind: "err" });
        return;
      }
      objectUrl = URL.createObjectURL(file);
      store.mediaObjectUrl = objectUrl;
      setMedia(objectUrl, file.name, { revokePrev: false });
      store.emit("msg", { text: `已加载本地视频 ${file.name}（仅在本机播放）`, kind: "ok" });
    }

    function loadUrl(url) {
      const u = String(url || "").trim();
      if (!u) return;
      if (!/^https?:\/\//i.test(u) && !u.startsWith("blob:") && !u.startsWith("file:")) {
        store.emit("msg", { text: "直链必须以 http(s):// 开头", kind: "err" });
        return;
      }
      setMedia(u, u.split("/").pop() || u);
      store.emit("msg", { text: "已尝试加载直链（能否播放取决于对方是否允许跨域）", kind: "" });
    }

    /* ------------------------------------------------------------ 跳转 */

    function seekTo(ms, { fromUser = false } = {}) {
      const target = Math.max(0, ms);
      store.setTime(target, { emit: !fromUser });
      if (!video.src) return;
      const sec = T.msToSec(target);
      if (Math.abs(video.currentTime - sec) > 1e-4) {
        seeking = true;
        pendingSeekMs = target;
        try {
          video.currentTime = sec;
        } catch (_) {
          seeking = false;
          pendingSeekMs = null;
        }
      }
    }

    // 当前时间属于第几帧 —— 用「就近取整」而不是 floor。
    //
    // 踩过的坑：900 / (1000/30) 在 IEEE754 下 = 26.999999999999996（不是 27），
    // 于是 floor 会认为 900ms 属于第 26 帧，后退一帧就退到 867ms，退过头。
    // 加 0.5 再 floor 等价于四舍五入，既不受浮点误差影响，
    // 也符合直觉：930ms 已经更靠近下一帧，就该算作下一帧。
    function frameOf(ms) {
      return Math.floor(ms / store.frameStep + 0.5);
    }
    function frameStart(frame) {
      return Math.round(frame * store.frameStep);
    }
    function stepFrames(n) {
      // 注意：如果当前时间正好卡在两帧中间，就近取整会把它算作后一帧，
      // 此时「后退一帧」仍会后退（目标 = 当前帧 - 1），不会出现原地不动。
      const target = frameStart(frameOf(store.time) + n);
      if (video.paused === false) video.pause();
      seekTo(target);
    }
    function stepSeconds(n) {
      seekTo(store.time + n * 1000);
    }
    function toStart() {
      seekTo(0);
    }
    function toEnd() {
      seekTo(video.duration > 0 ? video.duration * 1000 : store.duration);
    }

    /* ---------------------------------------------------------- 播放控制 */

    function togglePlay() {
      if (!video.src) {
        store.emit("msg", { text: "先加载一个视频文件", kind: "err" });
        return;
      }
      if (video.paused) {
        video.playbackRate = store.rate;
        const p = video.play();
        if (p && p.catch) p.catch((e) => store.emit("msg", { text: "播放失败：" + e.message, kind: "err" }));
      } else {
        video.pause();
      }
    }

    function applyRate(r) {
      store.setRate(Number(r));
      video.playbackRate = store.rate;
    }

    function applyFps(f) {
      try {
        store.setFps(f);
      } catch (e) {
        store.emit("msg", { text: e.message, kind: "err" });
        els.fps.value = store.fps;
      }
    }

    /* ------------------------------------------------------------ 事件 */

    video.addEventListener("loadedmetadata", () => {
      store.duration = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
      els.seek.max = String(Math.max(0, Math.round(store.duration)));
      store.emit("play", { duration: store.duration });
      // 加载后回到当前播放头，保证「先标时间再开视频」也不丢
      seekTo(store.time);
    });
    // 没加载媒体时，浏览器对 video.currentTime 的读写行为不一致（可能回退到 0），
    // 会把我们刚设好的播放头顶掉。所以：没有 src 时 store 是唯一权威，不读 video。
    video.addEventListener("timeupdate", () => {
      if (!video.src) return;
      const ms = video.currentTime * 1000;
      if (!Number.isFinite(ms)) return;
      // seek 在途时，浏览器会先报一个中间/取整值（例如想去 900ms 却报 867ms），
      // 直接采信会让「帧步进」出现 off-by-one。所以只要偏差超过一帧就丢弃。
      if (pendingSeekMs !== null && Math.abs(ms - pendingSeekMs) > store.frameStep) return;
      pendingSeekMs = null;
      store.setTime(ms);
    });
    video.addEventListener("seeked", () => {
      seeking = false;
      pendingSeekMs = null;
      if (!video.src) return;
      const ms = video.currentTime * 1000;
      if (Number.isFinite(ms)) store.setTime(ms);
    });
    video.addEventListener("play", () => store.setPlaying(true));
    video.addEventListener("pause", () => store.setPlaying(false));
    video.addEventListener("ended", () => store.setPlaying(false));
    video.addEventListener("error", () => {
      if (!video.src) return;
      store.emit("msg", { text: "视频加载失败（编码不支持 / 跨域被拒 / 路径失效）", kind: "err" });
    });

    // 播放时用 rAF 刷新 HUD（timeupdate 只有 4Hz，时间码会跳）
    function tick() {
      store.emit("frame", { time: store.time });
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    /* ---------------------------------------------------- 界面绑定 */

    els.btnPlay.addEventListener("click", togglePlay);
    els.btnBackFrame.addEventListener("click", () => stepFrames(-1));
    els.btnFwdFrame.addEventListener("click", () => stepFrames(1));
    els.btnBack1s.addEventListener("click", () => stepSeconds(-1));
    els.btnFwd1s.addEventListener("click", () => stepSeconds(1));
    els.btnStart.addEventListener("click", toStart);
    els.btnEnd.addEventListener("click", toEnd);
    els.pickVideo.addEventListener("click", () => els.fileInput.click());
    els.pickVideo2.addEventListener("click", () => els.fileInput.click());
    els.loadUrl.addEventListener("click", () => loadUrl(els.mediaUrl.value));
    els.mediaUrl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadUrl(els.mediaUrl.value);
    });
    els.fps.addEventListener("change", () => applyFps(els.fps.value));
    els.rate.addEventListener("change", () => applyRate(els.rate.value));

    els.seek.addEventListener("input", () => seekTo(Number(els.seek.value), { fromUser: true }));

    els.tcInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const ms = T.parseTimeInput(els.tcInput.value, store.time);
      seekTo(ms);
      els.tcInput.blur();
    });
    els.tcInput.addEventListener("blur", () => {
      els.tcInput.value = globalThis.DVY.util.msToTimestamp(Math.round(store.time));
    });

    // 拖放视频文件
    const wrap = els.videoWrap;
    wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrap.classList.add("drag");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drag"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.classList.remove("drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    /* ---------------------------------------------------------- 渲染 */

    let lastTc = "";
    function render() {
      const ms = Math.round(store.time);
      const tc = globalThis.DVY.util.msToTimestamp(ms);
      if (tc !== lastTc) {
        lastTc = tc;
        els.hudTc.textContent = tc;
        els.stTime.textContent = "播放头 " + tc;
        if (document.activeElement !== els.tcInput) els.tcInput.value = tc;
      }
      els.hudFps.textContent = `${store.fps} fps`;
      els.btnPlay.textContent = store.playing ? "❚❚" : "▶";
      if (document.activeElement !== els.seek && els.seek.max !== "0") {
        els.seek.value = String(ms);
      }
    }

    store.on("time", render);
    store.on("play", render);
    store.on("frame", render);

    /* ------------------------------------------------------ 对外接口 */

    return {
      render,
      loadFile,
      loadUrl,
      seekTo,
      stepFrames,
      stepSeconds,
      toStart,
      toEnd,
      togglePlay,
      applyFps,
      applyRate,
      get videoEl() {
        return video;
      },
      destroy() {
        cancelAnimationFrame(rafId);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.ui = globalThis.DVY.ui || {};
  globalThis.DVY.ui.video = { mount };
})();
