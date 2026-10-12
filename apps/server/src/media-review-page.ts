/** 使用普通网页控件，避免宿主浏览器点击原生媒体控件时页面崩溃。 */
export function mediaReviewPage(mediaPath: string, title: string, kind: "audio" | "video", nonce: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · 媒体审阅</title>
<style nonce="${nonce}">
body{margin:0;background:#15171c;color:#eee;font:16px system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:20px}
h1{font-size:18px;overflow-wrap:anywhere}video{display:block;width:100%;max-height:72vh;background:#08090c}audio{display:block}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:16px 0}button{font:inherit;padding:8px 20px;cursor:pointer}
input[type=range]{width:100%}p{color:#b8bdc8}#error{color:#ffb4b4}a{color:#a9caff}
</style><main><h1>${escape(title)}</h1>
<${kind} id="media" src="${escape(mediaPath)}" preload="metadata" playsinline></${kind}>
<div class="controls"><button id="play" type="button" disabled>播放</button><button id="replay" type="button" disabled>从头重播</button>
<label><input id="loop" type="checkbox">循环播放</label><output id="time">0.00 / 0.00 秒</output></div>
<input id="seek" aria-label="播放位置" type="range" min="0" max="0" value="0" step="0.01" disabled>
<p id="error" role="alert"></p><p>只读审阅；播放不会修改工程。<a href="${escape(mediaPath)}">原媒体文件</a></p></main>
<script nonce="${nonce}">
const media = document.getElementById('media');
const play = document.getElementById('play');
const replay = document.getElementById('replay');
const seek = document.getElementById('seek');
const time = document.getElementById('time');
const error = document.getElementById('error');
const update = () => {
  const duration = Number.isFinite(media.duration) ? media.duration : 0;
  const ready = duration > 0 && !media.error;
  play.disabled = replay.disabled = seek.disabled = !ready;
  seek.max = String(duration); seek.value = String(media.currentTime);
  time.textContent = media.currentTime.toFixed(2) + ' / ' + duration.toFixed(2) + ' 秒';
  play.textContent = media.paused || media.ended ? '播放' : '暂停';
};
const start = async () => {
  error.textContent = '';
  try { await media.play(); } catch (reason) { error.textContent = '播放失败：' + reason.message; }
  update();
};
play.addEventListener('click', () => { if (media.paused || media.ended) void start(); else media.pause(); });
replay.addEventListener('click', () => { media.currentTime = 0; void start(); });
seek.addEventListener('input', () => { media.currentTime = Number(seek.value); update(); });
document.getElementById('loop').addEventListener('change', (event) => { media.loop = event.target.checked; });
for (const event of ['loadedmetadata','durationchange','timeupdate','play','pause','ended']) media.addEventListener(event, update);
media.addEventListener('error', () => { error.textContent = '媒体加载或解码失败，请报告当前文件及错误码：' + (media.error?.code ?? '未知'); update(); });
update();
</script></html>`;
}
