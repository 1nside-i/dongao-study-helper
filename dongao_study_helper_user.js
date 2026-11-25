// ==UserScript==
// @name         东奥海南继续教育 · 学习助手
// @namespace    https://dongao-study-helper.local/
// @version      1.1.0
// @description  东奥海南继续教育（study.dongao.cn / jxjycwweb.dongao.cn）：点击“启动”后全自动顺序播放未完成讲次与课程（课程页常驻中继防双开竞争、讲次同页跳转免弹窗拦截、播放页延迟加载与Video.js自动唤起、最小化防暂停、自动关挂机弹窗、播完防卡死无响应、智能尾差识别）。默认不自动运行。
// @author       dsh-agent
// @match        https://study.dongao.cn/study/u/myCourseHN*
// @match        https://jxjycwweb.dongao.cn/cwweb/lecture/lectureList*
// @match        https://jxjycwweb.dongao.cn/cwweb/videoShow/video/videoPlay*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @noframes
// ==/UserScript==

/*
 * 设计说明（实现层面的事实，供审阅）
 * ---------------------------------------------------------------------------
 * 1. 三段页面各有独立适配器：course（课程列表）、lecture（讲次列表）、player（播放页）。
 *    协调状态机与纯决策逻辑（Core）分离：Core 不碰 DOM，只做“这一行算不算完成”“下一门课是哪门”等判断。
 * 2. 跨子域协调走 GM 存储（Tampermonkey 中同一脚本的存储在各子域、各标签共享）。
 *    账号 / 课程 / 讲次 / session 一律从当前页面动态读取，脚本里不存在任何身份信息或带签名的地址。
 * 3. 前进导航（课程→讲次列表→播放页）只点击页面里真实存在的 DOM 入口（a.onclick 里的
 *    watchCourse/watchCourseStart/videoPlay）；绝不点击“下载讲义”。
 *    回程（播放页→讲次列表）页面里没有入口，用“已实测过的路由 + 当前地址里的动态参数”跳转，
 *    不含 jsessionid，也不猜任何签名。
 * 4. 讲次是否完成只接受两类证据：
 *    (a) 行内明确的完成状态文案（精确匹配“已学完/已完成/学习完成/已完成学习/已通过”，
 *        且行内不存在“未完成/未学完/未学习/学习中/未通过/未开始”等否定语义）；
 *    (b) 总时长 > 0 且服务端重新渲染后 已学时长 >= 总时长。
 *    时长证据只证明“站点显示的已学时长达到总时长”，不代表学分结算完成；脚本不碰学分接口。
 *    99% 不算完成；0/0 不算完成；播放入口消失不能单独作为完成证据。
 * 5. ended 之后先等一段“初始等待”（initialVerifyWaitMs，默认 8s；这只是可调参数，
 *    并不是实测出来的网站保存周期），再回讲次列表核验；核验失败按有上限的退避重试，
 *    用尽后暂停任务并给出明确提示，不会跳过讲次、不会靠 currentTime 宣告完成。
 * 6. 多标签：GM 里有一份带过期时间的租约（lease），只有持有者执行播放；心跳续租。
 *    停止写全局任务状态，任何标签都能读到并停手；租约过期后其它标签可接管（需用户点“启动”）。
 * 7. 用户手动暂停会被记住，不自动续播；验证弹窗出现即暂停任务等用户处理；自动播放被拦时提示用户点击。
 * 8. 未在现场验证的点（讲次列表“已完成行”的具体文案、验证弹窗的真实 DOM、站点保存周期）
 *    都在代码里做了容错，并在《使用说明.md》里逐条标注为“待现场验证”。
 */

(function () {
  'use strict';

  // 幂等注入：页面被重复注入（或脚本被重复执行）时只保留第一份
  if (window.__DAH_INSTALLED__) return;
  window.__DAH_INSTALLED__ = true;

  /* ======================================================================
   * 1. 常量与配置
   * ==================================================================== */

  const VERSION = '1.1.0';
  const PLATFORM_CODE = 'jxjydongao'; // 讲次列表 / 播放页地址里的公开平台标识（已实测）
  const COURSE_LIST_URL = 'https://study.dongao.cn/study/u/myCourseHN';
  const PREFIX = 'dah.v1.';
  const K_TASK = PREFIX + 'task';
  const K_LEASE = PREFIX + 'lease';
  const K_COURSE_TAB = PREFIX + 'courseTab';
  const K_WORKER_TAB = PREFIX + 'workerTab';

  const DEFAULT_CONFIG = {
    /* --- DOM 等待（页面表格、入口、video 都可能延迟出现） --- */
    domWaitMs: 20000,
    videoWaitMs: 30000,
    /* --- 所有权租约 --- */
    leaseTtlMs: 20000,
    bgLeaseTtlMs: 90000, // 最小化/后台标签被浏览器节流（Chrome 约 60s 唤醒一次）时的自持租约宽限期
    heartbeatMs: 5000,
    handoffWaitMs: 4500, // 交接确认的硬上限：兼容公网加载讲次列表/播放页耗时，等不到新页面的持久 ack 就暂停并给人工入口
    sameTabDirectFallbackMs: 1800, // 讲次列表点击 videoPlay 后若未触发跳转，自动使用同页直达 URL 跳转的等待毫秒数（留足站点 AJAX 耗时）
    courseRelayWaitMs: 5000, // 本课全部讲次完成后等待已打开的「我的课程」标签页中继下一门课地址的窗口时间
    courseKeepAliveMs: 180000, // 「我的课程」页面后台会话保活间隔（3 分钟），防止长视频播放期间 study.dongao.cn 会话超时跳往 beijing.dongao.cn
    leaseRecoverMs: 1500, // 自己租约过期后重取的最小间隔（避免多个标签同时重取互相踩）
    leaseSettleMs: 160, // 写入租约后等待并读回校验的时间（并发仲裁）
    bgResumeDelaysMs: [80, 350, 1200], // 后台/最小化被暂停后的自动恢复重试阶梯
    mouseKeepAliveMs: 25000, // 周期性模拟鼠标微移间隔，防止站点 20 分钟无鼠标活动弹出“好久没有动”提示
    /* --- 完成核验 ---
     * initialVerifyWaitMs 只是“给网站留出的初始保存窗口”，是可调参数；
     * completeToleranceSec 为站点目录总时长与实际流时长/末次心跳落库时长的尾差容限（默认 60 秒，长视频按 3% 放宽至最高 120 秒），
     * 解决视频已播完但列表显示“还差十几秒”导致误报未完成并请求手动介入的问题。 */
    initialVerifyWaitMs: 2000,
    completeToleranceSec: 60,
    maxAutoReplaysPerLecture: 2,
    maxVerifyChecks: 4,
    retryBackoffMs: [6000, 10000, 15000],
    /* --- 其它轮询 --- */
    uiTickMs: 1000,
    pollMs: 2000,
    verifyPollMs: 1500,
    stallCheckMs: 20000,
    playRetryBackoffMs: [3000, 6000, 12000],
    maxCourseHops: 40
  };

  // 测试夹具可通过 window.__DAH_TEST_CONFIG__ 缩短时序；生产环境不会设置该变量。
  const TEST_OVERRIDE = (typeof window.__DAH_TEST_CONFIG__ === 'object' && window.__DAH_TEST_CONFIG__) || {};
  const CFG = Object.assign({}, DEFAULT_CONFIG, TEST_OVERRIDE);

  /* ======================================================================
   * 2. 纯决策逻辑 Core（不接触 DOM，可被测试直接调用）
   * ==================================================================== */

  const Core = {
    /** "00:35:45" | "35:45" | "1:02:03" -> 秒；无法解析返回 -1 */
    durationToSec(text) {
      if (typeof text !== 'string') return -1;
      const m = /^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
      if (!m) return -1;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (m[3] === undefined) return a * 60 + b;
      return a * 3600 + b * 60 + parseInt(m[3], 10);
    },

    /** 从行文本里取 "已学 / 总" 两个时长 */
    parseProgressPair(text) {
      if (typeof text !== 'string') return { learnedSec: -1, totalSec: -1, raw: '' };
      const m = /(\d{1,3}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,3}:\d{2}(?::\d{2})?)/.exec(text);
      if (!m) return { learnedSec: -1, totalSec: -1, raw: '' };
      return {
        learnedSec: Core.durationToSec(m[1]),
        totalSec: Core.durationToSec(m[2]),
        raw: m[0]
      };
    },

    formatSec(sec) {
      if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
      const s = Math.floor(sec % 60);
      const m = Math.floor((sec / 60) % 60);
      const h = Math.floor(sec / 3600);
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      return p(h) + ':' + p(m) + ':' + p(s);
    },

    /** 完成状态文案的精确判定；否定语义优先 */
    classifyStatusText(text) {
      const t = String(text == null ? '' : text).replace(/[\s\u3000]+/g, '');
      if (!t) return 'unknown';
      if (/(未完成|未学完|未学习|未通过|未开始|学习中|在学|待学习|待完成)/.test(t)) return 'incomplete';
      if (/^(已学完|已完成|学习完成|已完成学习|已通过)$/.test(t)) return 'complete';
      return 'unknown';
    },

    /**
     * 计算讲次完成的尾差容限（秒）：
     * 东奥讲次列表的“总时长”来自课程目录元数据，常比视频流实际时长或服务端末次落库时长多出 10~65 秒。
     * 对常规讲次（>=180 秒），容许 CFG.completeToleranceSec（默认 60 秒，或总时长的 3%，上限 120 秒）的尾差；
     * 对短测试视频（<180 秒），按总时长的 15%（上限 completeToleranceSec）计。
     */
    lectureToleranceSec(totalSec) {
      if (typeof totalSec !== 'number' || !isFinite(totalSec) || totalSec <= 0) return 0;
      const baseTol =
        typeof CFG.completeToleranceSec === 'number' && isFinite(CFG.completeToleranceSec) && CFG.completeToleranceSec >= 0
          ? CFG.completeToleranceSec
          : 60;
      if (totalSec >= 180) {
        return Math.min(120, Math.max(baseTol, Math.round(totalSec * 0.03)));
      }
      return Math.min(baseTol, Math.max(5, Math.floor(totalSec * 0.15)));
    },

    /**
     * 讲次行完成判定。
     * @param {{learnedSec:number,totalSec:number,statusText:string,playText?:string,completedByTask?:boolean}} row
     * @returns {{complete:boolean,nearComplete?:boolean,remainSec?:number,evidence:string[],reason:string}}
     */
    evaluateLecture(row) {
      const learned = row && typeof row.learnedSec === 'number' ? row.learnedSec : -1;
      const total = row && typeof row.totalSec === 'number' ? row.totalSec : -1;
      const statusKind = Core.classifyStatusText(row && row.statusText);
      const playText = String((row && row.playText) || '').replace(/[\s\u3000]+/g, '');
      const hasDuration = total > 0;
      const remainSec = hasDuration && learned >= 0 ? Math.max(0, total - learned) : -1;
      const tolSec = Core.lectureToleranceSec(total);
      const durationReached = hasDuration && learned >= 0 && learned >= total;
      const nearDurationReached = hasDuration && learned > 0 && remainSec > 0 && remainSec <= tolSec;
      const replayBtnComplete = /^(重新学习|再次学习|已学完)$/.test(playText) && learned > 0;
      const evidence = [];
      if (statusKind === 'incomplete') {
        evidence.push('状态文案「' + String(row.statusText).trim() + '」');
        return { complete: false, remainSec: remainSec, evidence, reason: '行内状态为未完成类文案，否定完成' };
      }
      if (statusKind === 'complete') {
        evidence.push('状态文案「' + String(row.statusText).trim() + '」');
        return { complete: true, remainSec: 0, evidence, reason: '行内明确完成状态' };
      }
      if (durationReached) {
        evidence.push('已学时长 ' + Core.formatSec(learned) + ' / 总时长 ' + Core.formatSec(total) + '（站点显示达到总时长）');
        return { complete: true, remainSec: 0, evidence, reason: '刷新后站点显示的已学时长达到总时长' };
      }
      if (nearDurationReached) {
        evidence.push(
          '已学时长 ' +
            Core.formatSec(learned) +
            ' / 总时长 ' +
            Core.formatSec(total) +
            '（仅差 ' +
            remainSec +
            ' 秒，在站点尾差容限 ' +
            tolSec +
            ' 秒内，视为已完成）'
        );
        return {
          complete: true,
          nearComplete: true,
          remainSec: remainSec,
          evidence,
          reason: '已学时长接近总时长（在站点尾差容限内）'
        };
      }
      if (replayBtnComplete) {
        evidence.push('操作入口为「' + playText + '」且已学 ' + Core.formatSec(learned));
        return { complete: true, remainSec: remainSec, evidence, reason: '操作入口显示重新学习' };
      }
      if (row && row.completedByTask) {
        evidence.push(
          '本轮已完整播放至结束（站点落库 ' + Core.formatSec(learned) + ' / ' + Core.formatSec(total) + '）'
        );
        return { complete: true, remainSec: remainSec, evidence, reason: '本轮已完整播放至结束并收敛' };
      }
      if (!hasDuration) evidence.push(total === 0 ? '总时长为 0/0，无法用时长判定' : '未能读到总时长');
      else evidence.push('已学时长 ' + Core.formatSec(learned) + ' / 总时长 ' + Core.formatSec(total) + '，未达总时长');
      return { complete: false, remainSec: remainSec, evidence, reason: '没有可接受的完成证据' };
    },

    /**
     * 课程行完成判定（课程列表的“学习状态”列是页面里真实存在的状态元素）。
     * 否定语义优先；无状态文案时才退到学分相等（低置信，仅用于避免卡在已完成课程上）。
     */
    evaluateCourse(row) {
      const statusKind = Core.classifyStatusText(row && row.statusText);
      const total = row && typeof row.creditTotal === 'number' ? row.creditTotal : -1;
      const done = row && typeof row.creditDone === 'number' ? row.creditDone : -1;
      const evidence = [];
      if (statusKind === 'incomplete') {
        evidence.push('学习状态「' + String(row.statusText).trim() + '」');
        return { complete: false, evidence, reason: '状态为进行中/未开始类' };
      }
      if (statusKind === 'complete') {
        evidence.push('学习状态「' + String(row.statusText).trim() + '」');
        return { complete: true, evidence, reason: '课程行明确完成状态' };
      }
      if (total > 0 && done >= 0 && done >= total) {
        evidence.push('已学学分 ' + done + ' / 总学分 ' + total + '（低置信）');
        return { complete: true, evidence, reason: '学分已满（无状态文案时的兜底）' };
      }
      evidence.push('未读到明确完成状态');
      return { complete: false, evidence, reason: '状态不明确' };
    },

    /**
     * 选下一门要学的课：从上一门之后开始环形查找；跳过已完成与本次运行里已判定“讲次全完成”的课。
     * @returns {object|null}
     */
    pickNextCourse(courses, lastKey, skipped) {
      if (!Array.isArray(courses) || !courses.length) return null;
      const n = courses.length;
      let start = -1;
      if (lastKey) {
        for (let i = 0; i < n; i++) if (courses[i].key === lastKey) { start = i; break; }
      }
      for (let k = 0; k < n; k++) {
        const item = courses[(start + 1 + k + n) % n];
        if (!item) continue;
        if (item.evaluation && item.evaluation.complete) continue;
        if (skipped) {
          if (skipped[item.key]) continue;
          const normName = item.name ? 'N:' + Core.normalizeTitle(item.name) : '';
          if (normName && skipped[normName]) continue;
        }
        return item;
      }
      return null;
    },

    /** 选第一个未完成的讲次（跳过已判定完成及本轮已确认播完收敛的讲次） */
    pickNextLecture(lectures, completedMap) {
      if (!Array.isArray(lectures)) return null;
      for (let i = 0; i < lectures.length; i++) {
        const item = lectures[i];
        if (!item) continue;
        if (item.evaluation && item.evaluation.complete) continue;
        if (completedMap && item.key && completedMap[item.key]) continue;
        return item;
      }
      return null;
    },

    /** 从 onclick 里取函数调用参数（去引号），取不到返回 null */
    extractCallArgs(src, fnName) {
      if (typeof src !== 'string' || !src) return null;
      const re = new RegExp(fnName + '\\s*\\(([^)]*)\\)');
      const m = re.exec(src);
      if (!m) return null;
      const parts = m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      return parts.map((s) => {
        const q = /^(['"])([\s\S]*)\1$/.exec(s);
        return q ? q[2] : null; // null 表示该参数不是字面量，调用方应视为“未知”
      });
    },

    /** 标题归一化，用于在没有 lectureID 时做兜底匹配 */
    normalizeTitle(text) {
      return String(text == null ? '' : text).replace(/[\s\u3000]+/g, '').replace(/^第[0-9一二三四五六七八九十百]+讲[.、]?/, '');
    },

    /** 租约是否可被当前标签占用 */
    leaseIsFree(lease, now, ttlMs) {
      if (!lease || !lease.owner) return true;
      if (lease.released) return true;
      const at = typeof lease.at === 'number' ? lease.at : 0;
      return now - at > ttlMs;
    }
  };

  /* ======================================================================
   * 3. 基础工具
   * ==================================================================== */

  const Utils = {
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    now() {
      return Date.now();
    },
    clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    },
    /** 轮询直到 fn 返回真值；超时返回 null */
    async waitUntil(fn, timeoutMs, intervalMs) {
      const t0 = Date.now();
      const step = intervalMs || 250;
      for (;;) {
        let v = null;
        try {
          v = fn();
        } catch (e) {
          v = null;
        }
        if (v) return v;
        if (Date.now() - t0 >= timeoutMs) return null;
        await Utils.sleep(step);
      }
    },
    safe(fn, label) {
      try {
        return fn();
      } catch (e) {
        Log.warn('内部操作失败' + (label ? '（' + label + '）' : '') + '：' + (e && e.message ? e.message : e));
        return null;
      }
    }
  };

  /* ======================================================================
   * 4. 日志（只在本地内存/控制台，不发送任何数据）
   * ==================================================================== */

  const Log = (function () {
    const MAX = 200;
    const lines = [];
    function push(level, text) {
      const line = { at: Date.now(), level: level, text: String(text) };
      lines.push(line);
      if (lines.length > MAX) lines.shift();
      const tag = '[东奥学习助手]';
      if (level === 'error') console.error(tag, line.text);
      else if (level === 'warn') console.warn(tag, line.text);
      else console.log(tag, line.text);
      if (typeof UI !== 'undefined' && UI.refreshLog) UI.refreshLog();
      return line;
    }
    return {
      info(text) {
        return push('info', text);
      },
      warn(text) {
        return push('warn', text);
      },
      error(text) {
        return push('error', text);
      },
      dump() {
        return lines.slice();
      },
      tail(n) {
        return lines.slice(Math.max(0, lines.length - (n || 5)));
      }
    };
  })();

  /* ======================================================================
   * 5. 存储层（GM 存储；无 GM 时退化为 localStorage，并提示跨子域会失效）
   * ==================================================================== */

  const Store = (function () {
    const hasGM =
      typeof GM_getValue === 'function' && typeof GM_setValue === 'function' && typeof GM_deleteValue === 'function';
    const LS_PREFIX = 'dah.v1.';
    let warned = false;

    function rawGet(key, def) {
      if (hasGM) {
        try {
          const v = GM_getValue(key, def);
          return v === undefined ? def : v;
        } catch (e) {
          return def;
        }
      }
      try {
        const v = localStorage.getItem(LS_PREFIX + key);
        return v === null ? def : v;
      } catch (e) {
        return def;
      }
    }

    function rawSet(key, value) {
      if (hasGM) {
        try {
          GM_setValue(key, value);
          return true;
        } catch (e) {
          return false;
        }
      }
      try {
        localStorage.setItem(LS_PREFIX + key, value);
        return true;
      } catch (e) {
        return false;
      }
    }

    function warningOnce() {
      if (hasGM || warned) return;
      warned = true;
      Log.warn('未检测到 GM 存储（GM_getValue/GM_setValue），跨子域协调会失效；请确认用户脚本已正确安装并授权。');
    }

    function readJSON(key) {
      warningOnce();
      const raw = rawGet(key, '');
      if (!raw || typeof raw !== 'string') return null;
      try {
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
      } catch (e) {
        return null;
      }
    }

    function writeJSON(key, obj) {
      warningOnce();
      try {
        return rawSet(key, JSON.stringify(obj));
      } catch (e) {
        return false;
      }
    }

    return {
      hasGM: hasGM,
      readTask() {
        return readJSON(K_TASK);
      },
      writeTask(task) {
        if (!task) return false;
        task.updatedAt = Date.now();
        return writeJSON(K_TASK, task);
      },
      clearTask() {
        if (hasGM) {
          try {
            GM_deleteValue(K_TASK);
          } catch (e) {
            /* 忽略 */
          }
        } else {
          try {
            localStorage.removeItem(LS_PREFIX + K_TASK);
          } catch (e) {
            /* 忽略 */
          }
        }
      },
      readLease() {
        return readJSON(K_LEASE);
      },
      writeLease(lease) {
        return writeJSON(K_LEASE, lease);
      },
      readCourseTab() {
        return readJSON(K_COURSE_TAB);
      },
      writeCourseTab(info) {
        return writeJSON(K_COURSE_TAB, info);
      },
      readWorkerTab() {
        return readJSON(K_WORKER_TAB);
      },
      writeWorkerTab(info) {
        return writeJSON(K_WORKER_TAB, info);
      },
      /** 监听任务/租约变化（TM 用 GM_addValueChangeListener，另加低频轮询兜底） */
      watch(onChange) {
        let bound = false;
        if (typeof GM_addValueChangeListener === 'function') {
          try {
            GM_addValueChangeListener(K_TASK, function (name, oldValue, newValue, remote) {
              if (remote) onChange('task');
            });
            GM_addValueChangeListener(K_LEASE, function (name, oldValue, newValue, remote) {
              if (remote) onChange('lease');
            });
            bound = true;
          } catch (e) {
            bound = false;
          }
        }
        if (!bound) Log.info('未启用跨标签即时通知，改用低频轮询（' + CFG.pollMs + 'ms）。');
        Timers.every('storePoll', function () {
          onChange('poll');
        }, CFG.pollMs);
      }
    };
  })();

  /* ======================================================================
   * 6. 定时器登记（可整体清理，避免停止后残留）
   * ==================================================================== */

  function makeTimerBag() {
    const map = new Map();
    const api = {
      setTimeout(name, fn, ms) {
        api.clear(name);
        const id = window.setTimeout(function () {
          map.delete(name);
          try {
            fn();
          } catch (e) {
            Log.error('定时任务「' + name + '」出错：' + (e && e.message ? e.message : e));
          }
        }, Math.max(0, ms));
        map.set(name, { id: id, periodic: false });
        return id;
      },
      every(name, fn, ms) {
        api.clear(name);
        const id = window.setInterval(function () {
          try {
            fn();
          } catch (e) {
            Log.error('周期任务「' + name + '」出错：' + (e && e.message ? e.message : e));
          }
        }, Math.max(50, ms));
        map.set(name, { id: id, periodic: true });
        return id;
      },
      clear(name) {
        const item = map.get(name);
        if (!item) return;
        if (item.periodic) window.clearInterval(item.id);
        else window.clearTimeout(item.id);
        map.delete(name);
      },
      clearAll() {
        map.forEach(function (item) {
          if (item.periodic) window.clearInterval(item.id);
          else window.clearTimeout(item.id);
        });
        map.clear();
      },
      size() {
        return map.size;
      },
      names() {
        return Array.from(map.keys());
      }
    };
    return api;
  }

  const Timers = makeTimerBag(); // 全局：UI 刷新、心跳、存储轮询
  const StepTimers = makeTimerBag(); // 步骤级：等待、重试、跳转，停止时整体清理

  /* ======================================================================
   * 7. 监听器登记（可靠清理）
   * ==================================================================== */

  const Listeners = (function () {
    const items = [];
    return {
      add(target, type, handler, opts) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, handler, opts);
        items.push({ target: target, type: type, handler: handler, opts: opts });
      },
      removeAll() {
        while (items.length) {
          const it = items.pop();
          try {
            it.target.removeEventListener(it.type, it.handler, it.opts);
          } catch (e) {
            /* 忽略 */
          }
        }
      }
    };
  })();

  /* ======================================================================
   * 8. 运行时状态（仅内存；跨页状态一律走 Store）
   * ==================================================================== */

  const S = {
    booted: false,
    tabId: '',
    page: '', // course | lecture | player
    runId: '', // 当前执行的“代次”；新一轮任务会换掉它，旧回调据此作废
    task: null,
    lease: null,
    executing: false,
    passive: false,
    handedOff: false, // 已把执行权交给新标签，本页不再执行/续租
    userPaused: false,
    verifyBlocked: false,
    autoplayBlocked: false,
    playIntent: false,
    /**
     * 暂停归因：script | stop | verify | lost | visibility | user | ''
     * 旧的单 bool（pausedByUs）会被“脚本暂停 + 站点初始化暂停 + 后台节流暂停”交错打乱，
     * 改成“原因 + 时间 + 序号”，handlePause 据此区分“这次 pause 是不是我们自己发起的”。
     */
    pauseCause: '',
    pauseAt: 0,
    lastScriptPause: null,
    expectPause: null,
    scriptPauseSeq: 0,
    playRequested: false,
    pauseEvents: [],
    handoffId: '',
    manualEl: null,
    leaseRecoverAt: 0,
    /** 是否已经有一路“重新取得执行权”在飞行中（同一秒里不许并发多路恢复） */
    leaseRecovering: false,
    endedHandled: false,
    video: null,
    videoBoundTo: null,
    notice: null,
    /**
     * 提示的来源标记：只有我们自己写下的、可能随状态变化而失效的提示才打标记
     * （目前只有“后台来源不明的暂停”）。播放真的恢复后据此把提示换回“正在播放”，
     * 避免出现“视频在播、蓝色提示还写着已暂停”的滞留（现场 19:23~19:25 的现象）。
     */
    noticeSource: '',
    lastPlayRetryAt: 0,
    playRetries: 0,
    stallCount: 0,
    lastProgressSec: -1,
    lastProgressAt: 0,
    navStartedAt: 0,
    stopSilenced: false,
    silencedReason: '',
    windowFocused: true,
    lastBlurAt: 0,
    lastUserGestureAt: 0,
    lastBgResumeAt: 0,
    bgResumeCount: 0,
    lastTimeUpdateRenewAt: 0,
    lastMouseKeepAliveAt: 0,
    mouseKeepAliveTick: 0,
    lastIdleDismissAt: 0,
    lastIdleScanAt: 0,
    idleDismissCount: 0,
    lastCourseKeepAliveAt: 0,
    lastPresenceTouchAt: 0,
    becomingExecutor: false,
    lastBoundCourseName: '',
    navigatingInternal: false,
    hadWorkerRelay: false,
    durationLogged: false,
    playerReloadedOnce: false
  };

  /* ======================================================================
   * 9. DOM 工具
   * ==================================================================== */

  const Dom = {
    qs(sel, root) {
      try {
        return (root || document).querySelector(sel);
      } catch (e) {
        return null;
      }
    },
    qsa(sel, root) {
      try {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
      } catch (e) {
        return [];
      }
    },
    text(el) {
      if (!el) return '';
      const t = el.textContent;
      return t == null ? '' : String(t).replace(/[\s\u3000]+/g, ' ').trim();
    },
    visible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
      return true;
    },
    click(el) {
      if (!el) return false;
      try {
        if (typeof el.click === 'function') {
          el.click();
          return true;
        }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (e) {
        Log.error('点击页面入口失败：' + (e && e.message ? e.message : e));
        return false;
      }
    },
    /**
     * 入口是否带有“本站同页可用的原生链接”：只有链接目标与预期页面类型一致时才用。
     * 目的：站点用新标签打开页面时，脚本的点击没有用户手势 → 可能被浏览器拦截；
     * 走入口自带的真实 href 同页跳转不会被拦截，也不猜任何签名/账号参数。
     * @param {Element} el 入口元素
     * @param {'lecture'|'player'} expectPage 预期打开哪一种页面
     * @returns {URL|null}
     */
    sameTabNav(el, expectPage) {
      if (!el || !expectPage) return null;
      let a = null;
      try {
        a = el.closest ? el.closest('a[href]') : el.tagName === 'A' ? el : null;
      } catch (e) {
        a = null;
      }
      if (!a) return null;
      const raw = a.getAttribute('href') || '';
      if (!raw || /^javascript:/i.test(raw) || /^#/.test(raw)) return null;
      let u;
      try {
        u = new URL(raw, location.href);
      } catch (e) {
        return null;
      }
      if (!/^https?:$/.test(u.protocol)) return null;
      if (u.origin !== location.origin) return null;
      if (!/\?/.test(raw)) return null; // 没有查询参数的链接多半不是真实入口
      const want = expectPage === 'lecture' ? '/lecture/lectureList' : expectPage === 'player' ? '/videoShow/video/videoPlay' : '';
      if (!want) return null;
      if (String(u.pathname).indexOf(want) < 0) return null;
      return u;
    },

    /** 解析时间文本里的数字（"2" / "2.0" / "2 学分"） */
    num(text) {
      const m = /-?\d+(?:\.\d+)?/.exec(String(text == null ? '' : text));
      return m ? parseFloat(m[0]) : -1;
    }
  };

  /* ======================================================================
   * 10. 页面识别
   * ==================================================================== */

  const Pages = {
    detect() {
      const host = location.hostname;
      const path = location.pathname;
      if (host === 'study.dongao.cn' && /^\/study\/u\/myCourseHN/.test(path)) return 'course';
      if (host === 'jxjycwweb.dongao.cn' && /^\/cwweb\/lecture\/lectureList/.test(path)) return 'lecture';
      if (host === 'jxjycwweb.dongao.cn' && /^\/cwweb\/videoShow\/video\/videoPlay/.test(path)) return 'player';
      return '';
    },
    /** 页面上出现密码框 / 明确登录文案，且没有本脚本要的表格 -> 视为登录失效 */
    loginSuspect() {
      if (Dom.qs('input[type="password"]')) return true;
      const bodyText = Dom.text(document.body).slice(0, 4000);
      if (/请重新登录|登录已过期|请先登录/.test(bodyText)) return true;
      return false;
    }
  };

  /* ======================================================================
   * 11. 适配器 A：课程列表（study.dongao.cn/study/u/myCourseHN）
   * ==================================================================== */

  /**
   * 课程行入口的真实调用签名（已现场观察到的结构，按参数个数严格校验）：
   *   watchCourse('119','2026','5614',ACCOUNT,'0','ENROLLMENT','1')                   // 7 个参数
   *   watchCourseStart('119','2026','5614','1','false','toList',ACCOUNT,'ENROLLMENT') // 8 个参数
   * args[0]=地区/机构（同一地区所有课程都是 119），args[1]=年份，args[2]=选课侧课程 id；
   * 账号在 watchCourse 的 args[3]、watchCourseStart 的 args[6]。
   * 这些都不等于课件 cwID（讲次列表/播放页地址里的 cwID 是 100004820 这类值），
   * 所以这里只按位置取“选课 id / 账号”，绝不把任何参数当 cwID 用。
   */
  const CourseCall = {
    parse(src) {
      if (!src) return null;
      const a8 = Core.extractCallArgs(src, 'watchCourseStart');
      if (a8) {
        if (a8.length !== 8) return null; // 结构不认识：宁可不用，也不猜
        return { signature: 'watchCourseStart', region: a8[0], year: a8[1], enrollId: a8[2], account: a8[6] };
      }
      const a7 = Core.extractCallArgs(src, 'watchCourse');
      if (a7) {
        if (a7.length !== 7) return null;
        return { signature: 'watchCourse', region: a7[0], year: a7[1], enrollId: a7[2], account: a7[3] };
      }
      return null;
    },

    isEnrollId(v) {
      return !!v && /^[0-9]{2,}$/.test(String(v));
    },

    isAccount(v) {
      return !!v && /^[0-9]{5,}$/.test(String(v)); // 真实账号是较长的数字串，年份 2026 之类不会被误认
    }
  };

  const CourseAdapter = {
    /** 找课程表格：优先带“课程名称 + 学习状态”表头的表 */
    findTable() {
      const tables = Dom.qsa('table');
      let best = null;
      for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        const head = Dom.text(t);
        if (head.indexOf('课程名称') >= 0 && (head.indexOf('学习状态') >= 0 || head.indexOf('总学分') >= 0)) {
          best = t;
          if (head.indexOf('学习状态') >= 0) break;
        }
      }
      if (best) return best;
      for (let i = 0; i < tables.length; i++) {
        if (Dom.qsa('tr', tables[i]).length >= 2) return tables[i];
      }
      return null;
    },

    /** 表头列索引（读不到就用已知的固定位置） */
    headerMap(table) {
      const map = { index: 0, name: 1, category: 2, creditTotal: 3, creditDone: 4, studyTime: 5, status: 6, ops: 7 };
      const firstRow = Dom.qs('tr', table);
      if (!firstRow) return map;
      const cells = Dom.qsa('th,td', firstRow);
      if (!cells.length) return map;
      const hasTh = Dom.qsa('th', firstRow).length > 0;
      if (!hasTh && Dom.text(firstRow).indexOf('课程名称') < 0) return map;
      const names = cells.map(function (c) {
        return Dom.text(c);
      });
      const find = function (kw) {
        for (let i = 0; i < names.length; i++) if (names[i].indexOf(kw) >= 0) return i;
        return -1;
      };
      const result = Object.assign({}, map);
      const setIf = function (key, kw, fallback) {
        const idx = find(kw);
        result[key] = idx >= 0 ? idx : fallback;
      };
      setIf('index', '序号', 0);
      setIf('name', '课程名称', 1);
      setIf('category', '课程类别', 2);
      setIf('creditTotal', '总学分', 3);
      setIf('creditDone', '已学学分', 4);
      setIf('studyTime', '学习时长', 5);
      setIf('status', '学习状态', 6);
      setIf('ops', '操作', names.length - 1);
      return result;
    },

    /** 课程行入口：听课详情 > 课程名称链接 > 继续/开始学习；绝不选下载类入口 */
    findEntry(row, map) {
      const opsCell = Dom.qsa('td', row)[map.ops] || row;
      const links = Dom.qsa('a', row);
      const isDownload = function (a) {
        return /download/i.test(a.getAttribute('onclick') || '') || Dom.text(a).indexOf('下载') >= 0;
      };
      for (let i = 0; i < links.length; i++) {
        const a = links[i];
        if (isDownload(a)) continue;
        if (Dom.text(a).indexOf('听课详情') >= 0) return { el: a, kind: '听课详情' };
      }
      const nameLinks = Dom.qsa('a', Dom.qsa('td', row)[map.name] || row);
      for (let i = 0; i < nameLinks.length; i++) {
        if (!isDownload(nameLinks[i])) return { el: nameLinks[i], kind: '课程名称' };
      }
      for (let i = 0; i < links.length; i++) {
        const a = links[i];
        if (isDownload(a)) continue;
        const t = Dom.text(a);
        if (t.indexOf('继续学习') >= 0 || t.indexOf('开始学习') >= 0) return { el: a, kind: t };
      }
      return null;
    },

    /** 课程行里能认出来的真实调用（用于 key / 账号 / 日志） */
    callOf(row) {
      const links = Dom.qsa('a', row);
      for (let i = 0; i < links.length; i++) {
        const info = CourseCall.parse(links[i].getAttribute('onclick') || '');
        if (info) return info;
      }
      return null;
    },

    /**
     * 课程 key：优先选课侧课程 id（真实签名里的 args[2]，例如 5614），否则用课程名称。
     * 这里不含也不猜 cwID —— 同一地区多门课 args[0] 都是 119，用它做 key 会全部撞在一起。
     */
    keyOf(row, map) {
      const info = CourseAdapter.callOf(row);
      if (info && CourseCall.isEnrollId(info.enrollId)) return 'E:' + info.enrollId;
      const name = Dom.text(Dom.qsa('td', row)[map.name] || row);
      return 'N:' + Core.normalizeTitle(name);
    },

    /** 解析全部课程行；未就绪返回 null */
    parse() {
      const table = CourseAdapter.findTable();
      if (!table) return null;
      const map = CourseAdapter.headerMap(table);
      const rows = Dom.qsa('tr', table);
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cells = Dom.qsa('td', row);
        if (cells.length < 4) continue; // 表头 / 空行
        const name = Dom.text(cells[map.name] || cells[1] || row);
        if (!name || name.indexOf('课程名称') >= 0) continue;
        const statusText = Dom.text(cells[map.status] || '');
        const creditTotal = Dom.num(Dom.text(cells[map.creditTotal] || ''));
        const creditDone = Dom.num(Dom.text(cells[map.creditDone] || ''));
        const entry = CourseAdapter.findEntry(row, map);
        const item = {
          key: CourseAdapter.keyOf(row, map),
          name: name,
          statusText: statusText,
          creditTotal: creditTotal,
          creditDone: creditDone,
          callInfo: CourseAdapter.callOf(row),
          entry: entry,
          el: row
        };
        item.evaluation = Core.evaluateCourse(item);
        out.push(item);
      }
      return out.length ? out : null;
    }
  };

  /* ======================================================================
   * 12. 适配器 B：讲次列表（jxjycwweb.dongao.cn/cwweb/lecture/lectureList）
   * ==================================================================== */

  const LectureAdapter = {
    findTable() {
      const tables = Dom.qsa('table');
      let best = null;
      for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        const head = Dom.text(t);
        if (head.indexOf('已学时长') >= 0 || head.indexOf('课程目录') >= 0) {
          best = t;
          if (head.indexOf('已学时长') >= 0) break;
        }
      }
      if (best) return best;
      // 兜底：取行数最多、且行内带 HH:MM:SS / HH:MM:SS 的表
      let bestRows = 0;
      for (let i = 0; i < tables.length; i++) {
        const rows = Dom.qsa('tr', tables[i]).filter(function (r) {
          return /\d{1,3}:\d{2}(:\d{2})?\s*\/\s*\d{1,3}:\d{2}(:\d{2})?/.test(Dom.text(r));
        });
        if (rows.length > bestRows) {
          bestRows = rows.length;
          best = tables[i];
        }
      }
      return best;
    },

    /** 行内状态文案：取所有单元格/状态元素中能精确归类的那一个 */
    statusTextOf(row) {
      const cells = Dom.qsa('td', row);
      for (let i = 0; i < cells.length; i++) {
        const t = Dom.text(cells[i]);
        if (t && Core.classifyStatusText(t) !== 'unknown') return t;
      }
      const marks = Dom.qsa('[class*="status"],[class*="state"],.state,.status', row);
      for (let i = 0; i < marks.length; i++) {
        const t = Dom.text(marks[i]);
        if (t && Core.classifyStatusText(t) !== 'unknown') return t;
      }
      return '';
    },

    /** 播放入口：onclick 必须真的调用 videoPlay(...)，并排除下载讲义 */
    findPlayEntry(row) {
      const links = Dom.qsa('a', row);
      for (let i = 0; i < links.length; i++) {
        const a = links[i];
        const src = a.getAttribute('onclick') || '';
        if (/download/i.test(src)) continue;
        if (Core.extractCallArgs(src, 'videoPlay')) {
          return { el: a, source: 'videoPlay', onclick: src };
        }
      }
      // 没有 videoPlay 时，退到“开始学习/继续学习/重新学习”按钮（仍排除下载）
      for (let i = 0; i < links.length; i++) {
        const a = links[i];
        const src = a.getAttribute('onclick') || '';
        if (/download/i.test(src)) continue;
        const t = Dom.text(a);
        if (t.indexOf('下载') >= 0) continue;
        if (
          t.indexOf('继续学习') >= 0 ||
          t.indexOf('开始学习') >= 0 ||
          t.indexOf('重新学习') >= 0 ||
          t.indexOf('再次学习') >= 0 ||
          t.indexOf('听课') >= 0
        ) {
          return { el: a, source: 'text', onclick: src };
        }
      }
      return null;
    },

    /** 讲次 key：优先 videoPlay 的 lectureID（动态读取），否则标题归一化 */
    keyOf(row, play, title) {
      if (play && play.onclick) {
        const args = Core.extractCallArgs(play.onclick, 'videoPlay');
        if (args && args.length >= 2 && args[1]) return 'L:' + args[1];
        if (args && args.length === 1 && args[0]) return 'L:' + args[0];
      }
      // 下载链接里同样带 lectureID，只用来做 key，不用于播放
      const dl = Dom.qsa('a', row).filter(function (a) {
        return /downloadLecture/.test(a.getAttribute('onclick') || '');
      })[0];
      if (dl) {
        const args = Core.extractCallArgs(dl.getAttribute('onclick') || '', 'downloadLecture');
        if (args && args.length >= 2 && args[1]) return 'L:' + args[1];
      }
      return 'T:' + Core.normalizeTitle(title);
    },

    parse() {
      const table = LectureAdapter.findTable();
      if (!table) return null;
      const curTask = Store.readTask();
      const completedMap = (curTask && curTask.completedLectures) || {};
      const rows = Dom.qsa('tr', table);
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cells = Dom.qsa('td', row);
        if (!cells.length) continue; // 表头
        const title = Dom.text(cells[0] || row);
        if (!title) continue;
        const rowText = Dom.text(row);
        const progress = Core.parseProgressPair(rowText);
        const play = LectureAdapter.findPlayEntry(row);
        const statusText = LectureAdapter.statusTextOf(row);
        const key = LectureAdapter.keyOf(row, play, title);
        const item = {
          index: out.length + 1,
          title: title,
          key: key,
          learnedSec: progress.learnedSec,
          totalSec: progress.totalSec,
          progressRaw: progress.raw,
          statusText: statusText,
          playText: play && play.el ? Dom.text(play.el) : '',
          completedByTask: Boolean(key && completedMap[key]),
          play: play,
          el: row
        };
        item.evaluation = Core.evaluateLecture(item);
        out.push(item);
      }
      return out.length ? out : null;
    },

    /**
     * 讲次列表页的课程名称。已现场观察：这个页面的 `document.title` 就是课程名
     * （例如「重磅！《增值税法》来了!」「纳税缴费信用管理办法」），因此以 title 为准；
     * class / h1 / h2 只作兜底。两种来源都走同一套规范化后**精确相等**比较。
     */
    courseName() {
      const clean = function (s) {
        return String(s || '')
          .replace(/\s+/g, ' ')
          .trim();
      };
      const title = clean(document.title);
      if (title && title !== '课程目录' && title !== '无标题') return title;
      const cands = [
        Dom.qs('.course-name'),
        Dom.qs('.courseName'),
        Dom.qs('.course-title'),
        Dom.qs('[class*="course"][class*="name"]'),
        Dom.qs('h2'),
        Dom.qs('h1')
      ];
      for (let i = 0; i < cands.length; i++) {
        const t = cands[i] ? clean(Dom.text(cands[i])) : '';
        if (t) return t.replace(/^课程目录[：:]\s*/, '').trim();
      }
      return '';
    },

    /** 当前列表里所有讲次都被认定为完成时，用来给“本课已结束”的日志做证据 */
    summarize(rows) {
      return rows
        .map(function (r) {
          return '「' + r.title + '」' + (r.evaluation.complete ? '完成' : '未完成') + '（' + r.evaluation.evidence.join('；') + '）';
        })
        .join(' | ');
    }
  };

  /* ======================================================================
   * 13. 适配器 C：播放页（jxjycwweb.dongao.cn/cwweb/videoShow/video/videoPlay）
   * ==================================================================== */

  const PlayerAdapter = {
    video() {
      const cands = Dom.qsa('video#player_daPlayer_html5_api, video#player_daPlayer, video.vjs-tech, video');
      for (let i = 0; i < cands.length; i++) {
        const v = cands[i];
        if (v && v.isConnected && typeof v.duration === 'number' && isFinite(v.duration) && v.duration > 0) return v;
      }
      for (let i = 0; i < cands.length; i++) {
        const v = cands[i];
        if (v && v.isConnected && (v.readyState >= 1 || v.currentSrc || v.src)) return v;
      }
      for (let i = 0; i < cands.length; i++) {
        if (cands[i] && cands[i].isConnected) return cands[i];
      }
      return cands[0] || null;
    },

    isUiPaused(video) {
      const v = video || S.video;
      if (!v) return false;
      const wrap = (v.closest && v.closest('.video-js')) || Dom.qs('#player_daPlayer.video-js, .video-js');
      if (wrap && wrap.classList && wrap.classList.contains('vjs-paused')) return true;
      return false;
    },

    playControl() {
      return Dom.qs('.vjs-play-control') || Dom.qs('.vjs-big-play-button') || null;
    },

    urlParams() {
      const out = { cwID: '', lectureID: '', accountId: '' };
      try {
        const u = new URL(location.href);
        out.cwID = u.searchParams.get('cwID') || '';
        out.lectureID = u.searchParams.get('lectureID') || '';
        out.accountId = u.searchParams.get('accountId') || '';
        // 有些地址把参数挂在 jsessionid 之后
        if (!out.cwID) {
          const m = /[?&]cwID=([^&]+)/.exec(location.href);
          if (m) out.cwID = decodeURIComponent(m[1]);
        }
        if (!out.lectureID) {
          const m2 = /[?&]lectureID=([^&#]+)/.exec(location.href);
          if (m2) out.lectureID = decodeURIComponent(m2[1]);
        }
        if (!out.accountId) {
          const m3 = /[?&]accountId=([^&#]+)/.exec(location.href);
          if (m3) out.accountId = decodeURIComponent(m3[1]);
        }
      } catch (e) {
        /* 忽略 */
      }
      return out;
    },

    /** 页面自带配置（只读，不据此改倍速/跳进度；语义未核实，仅记录） */
    pageConfig() {
      const names = [
        'autoJumpNextCourseFlag',
        'listenVerifyType',
        'listenVerifyInterval',
        'isCapture',
        'isListenFace',
        'isCoursewareQuestion'
      ];
      const out = {};
      for (let i = 0; i < names.length; i++) {
        try {
          // eslint-disable-next-line no-eval
          const v = (0, eval)(names[i]);
          if (typeof v !== 'undefined') out[names[i]] = String(v);
        } catch (e) {
          /* 变量不存在 */
        }
      }
      return out;
    },

    /**
     * 验证弹窗探测（启发式，真实 DOM 未观察到）。
     * 只在“可见 + 含验证类文案”时认定为验证阻塞，避免把普通弹窗当验证。
     */
    verificationOverlay() {
      const verifyText = /(请完成验证|请进行验证|安全验证|身份验证|拖动滑块|滑动验证|完成滑块|人脸识别|请完成人脸|扫码验证|图形验证|请输入验证码)/;
      const candidates = Dom.qsa(
        '[class*="verify"],[id*="verify"],.layui-layer,.el-dialog,.ant-modal,.modal,.vjs-modal-dialog,[class*="dialog"],[class*="mask"]'
      );
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (!Dom.visible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 60) continue;
        const t = Dom.text(el).slice(0, 400);
        if (t && verifyText.test(t)) return { el: el, text: t.slice(0, 120) };
      }
      const frames = Dom.qsa('iframe');
      for (let i = 0; i < frames.length; i++) {
        const src = frames[i].getAttribute('src') || '';
        if (/verify|face|captcha|slide/i.test(src) && Dom.visible(frames[i])) {
          return { el: frames[i], text: 'iframe:' + src.slice(0, 80) };
        }
      }
      return null;
    },

    /**
     * 判断视频是否已到达播放末尾（兼容 HLS/Video.js 在流结束前 0.5~2 秒先触发 pause 事件再置 ended=true 的行为）。
     */
    nearVideoEnd(video) {
      const v = video || S.video;
      if (!v) return false;
      if (v.ended) return true;
      const dur = v.duration;
      const cur = v.currentTime;
      if (typeof dur === 'number' && isFinite(dur) && dur > 30 && typeof cur === 'number' && isFinite(cur)) {
        if (cur >= dur - 2.5) return true;
      }
      return false;
    },

    /**
     * 判断弹窗元素是否处于已渲染显示状态（兼容后台最小化时 requestAnimationFrame 暂停导致 CSS 动画停留在 opacity:0 的情况）。
     */
    popupRendered(el) {
      if (!el || !el.getBoundingClientRect) return false;
      if (el.hidden) return false;
      const inlineStyle = el.style;
      if (inlineStyle && (inlineStyle.display === 'none' || inlineStyle.visibility === 'hidden')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 10) {
        if (cur.hidden) return false;
        const st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
        cur = cur.parentElement;
        depth++;
      }
      return true;
    },

    /**
     * 模拟轻量级鼠标移动保活（重置东奥播放页“您有好久没有动了，快快动一下鼠标！”的 20 分钟无操作计时器）。
     */
    simulateMouseActivity() {
      try {
        if (S.endedHandled || PlayerAdapter.nearVideoEnd(S.video)) return;
        S.mouseKeepAliveTick = ((S.mouseKeepAliveTick || 0) + 1) % 20;
        const x = 320 + S.mouseKeepAliveTick * 7;
        const y = 240 + S.mouseKeepAliveTick * 5;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x + 60,
          screenY: y + 80
        };
        const targets = [S.video, Dom.qs('#player_daPlayer'), document];
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (!t || typeof t.dispatchEvent !== 'function') continue;
          t.dispatchEvent(new MouseEvent('mousemove', init));
        }
      } catch (e) {
        /* 忽略 */
      }
    },

    /**
     * 自动检测并点击东奥长时间后台挂机弹窗（如「温馨提示：您有好久没有动了，快快动一下鼠标！」-> 点击「确定」）。
     * @returns {boolean} 是否检测到并点击了挂机弹窗
     */
    dismissIdlePrompt(forceNow) {
      if (S.endedHandled || PlayerAdapter.nearVideoEnd(S.video)) return false;
      const now = Date.now();
      if (!forceNow && now - (S.lastIdleScanAt || 0) < 600) return false;
      S.lastIdleScanAt = now;
      if (now - (S.lastIdleDismissAt || 0) < 500) return false;

      const idlePromptRe = /(好久没有动|动一下鼠标|快快动|长时间未操作)/;
      const captchaRe = /(拖动滑块|滑动验证|完成滑块|人脸识别|请完成人脸|扫码验证|图形验证|请输入验证码)/;
      const btnTextRe = /^(确定|确认|继续学习|继续听课|继续播放|继续观看|继续|我知道了|好的|是)$/;

      if (!document.body) return false;
      const bodyRaw = document.body.textContent || '';
      if (!idlePromptRe.test(bodyRaw)) return false;

      const cands = Dom.qsa('div,p,span', document.body);
      let msgEl = null;
      for (let i = 0; i < cands.length; i++) {
        const el = cands[i];
        if (el.id === 'dah-panel' || (el.closest && el.closest('#dah-panel'))) continue;
        const raw = el.textContent || '';
        if (!raw || raw.length > 220 || !idlePromptRe.test(raw) || captchaRe.test(raw)) continue;
        if (!PlayerAdapter.popupRendered(el)) continue;
        const subDivs = Dom.qsa('div,p,span', el);
        let childHas = false;
        for (let k = 0; k < subDivs.length; k++) {
          if (idlePromptRe.test(subDivs[k].textContent || '') && PlayerAdapter.popupRendered(subDivs[k])) {
            childHas = true;
            break;
          }
        }
        if (!childHas) {
          msgEl = el;
          break;
        }
      }
      if (!msgEl) return false;

      let cur = msgEl;
      let confirmBtn = null;
      let depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
        if (captchaRe.test(cur.textContent || '')) break;
        const btns = Dom.qsa('button,a,input,span,div', cur);
        for (let j = 0; j < btns.length; j++) {
          const c = btns[j];
          if (c === cur || c === msgEl) continue;
          const rawTxt = c.tagName === 'INPUT' ? String(c.value || '').trim() : String(c.textContent || '').replace(/[\s\u3000]+/g, '');
          if (!btnTextRe.test(rawTxt)) continue;
          if (!PlayerAdapter.popupRendered(c)) continue;
          const innerHas = Dom.qsa('button,a,input,span,div', c).some(function (sub) {
            return btnTextRe.test(String(sub.textContent || '').replace(/[\s\u3000]+/g, '')) && PlayerAdapter.popupRendered(sub);
          });
          if (!innerHas) {
            confirmBtn = c;
            break;
          }
        }
        if (confirmBtn) break;
        cur = cur.parentElement;
        depth++;
      }

      if (confirmBtn) {
        S.lastIdleDismissAt = now;
        S.idleDismissCount = (S.idleDismissCount || 0) + 1;
        PlayerAdapter.simulateMouseActivity();
        Dom.click(confirmBtn);
        Log.info('检测到后台挂机提醒弹窗（「' + Dom.text(msgEl).slice(0, 40) + '」），已自动点击「' + Dom.text(confirmBtn).trim() + '」并恢复播放。');
        return true;
      }
      return false;
    }
  };

  /* ======================================================================
   * 14. 面板 UI（小型中文面板，只做展示与按钮）
   * ==================================================================== */

  const UI = (function () {
    const els = {};
    let expanded = false;
    let mounted = false;

    const CSS = [
      '#dah-panel{position:fixed;right:16px;bottom:16px;width:308px;z-index:2147483000;',
      'background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);',
      'font:12px/1.55 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#333;overflow:hidden}',
      '#dah-panel .dah-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:7px 10px;background:#ff6a00;color:#fff;cursor:pointer;font-weight:600;font-size:12px}',
      '#dah-panel .dah-head span.dah-ver{font-weight:400;opacity:.85;font-size:11px}',
      '#dah-panel .dah-body{padding:8px 10px 10px}',
      '#dah-panel.dah-collapsed .dah-body{display:none}',
      '#dah-panel .dah-row{display:flex;gap:6px;margin:2px 0}',
      '#dah-panel .dah-k{color:#888;flex:0 0 40px}',
      '#dah-panel .dah-v{flex:1 1 auto;word-break:break-all;color:#222}',
      '#dah-panel .dah-notice{margin-top:6px;padding:6px 8px;border-radius:5px;display:none;font-size:12px;word-break:break-all}',
      '#dah-panel .dah-notice.dah-info{display:block;background:#f2f8ff;color:#1f4f8f;border:1px solid #d6e6fb}',
      '#dah-panel .dah-notice.dah-warn{display:block;background:#fff9e8;color:#8a5a00;border:1px solid #ffe6a8}',
      '#dah-panel .dah-notice.dah-error{display:block;background:#fdf1f0;color:#a11d10;border:1px solid #f6c9c4}',
      '#dah-panel .dah-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '#dah-panel button{border:1px solid #d6d6d6;background:#fafafa;color:#333;border-radius:5px;',
      'padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}',
      '#dah-panel button:hover{background:#f0f0f0}',
      '#dah-panel button.dah-primary{background:#ff6a00;border-color:#ff6a00;color:#fff}',
      '#dah-panel button.dah-primary:hover{background:#e85f00}',
      '#dah-panel button.dah-danger{color:#a11d10;border-color:#f0c6c1}',
      '#dah-panel button[disabled]{opacity:.45;cursor:not-allowed}',
      '#dah-panel .dah-log{margin-top:8px;border-top:1px dashed #e6e6e6;padding-top:6px;',
      'font:11px/1.5 Consolas,Menlo,monospace;color:#666;max-height:78px;overflow:auto;display:none;white-space:pre-wrap;word-break:break-all}',
      '#dah-panel.dah-expanded .dah-log{display:block;max-height:190px}',
      '#dah-panel .dah-hint{color:#999;font-size:11px;margin-top:4px}'
    ].join('');

    function h(tag, attrs, children) {
      const el = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          if (k === 'text') el.textContent = attrs[k];
          else if (k === 'class') el.className = attrs[k];
          else el.setAttribute(k, attrs[k]);
        });
      }
      (children || []).forEach(function (c) {
        if (c) el.appendChild(c);
      });
      return el;
    }

    function row(k, id) {
      return h('div', { class: 'dah-row' }, [h('div', { class: 'dah-k', text: k }), h('div', { class: 'dah-v', id: id, text: '—' })]);
    }

    function mount() {
      if (mounted && document.getElementById('dah-panel')) return;
      const old = document.getElementById('dah-panel');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      const style = document.getElementById('dah-style');
      if (!style) document.head.appendChild(h('style', { id: 'dah-style', text: CSS }));

      els.head = h('div', { class: 'dah-head' }, [
        h('span', { text: '东奥学习助手' }),
        h('span', { class: 'dah-ver', text: 'v' + VERSION })
      ]);
      els.status = h('div', { class: 'dah-v', id: 'dah-status', text: '未启动' });
      els.course = h('div', { class: 'dah-v', id: 'dah-course', text: '—' });
      els.lecture = h('div', { class: 'dah-v', id: 'dah-lecture', text: '—' });
      els.notice = h('div', { class: 'dah-notice', id: 'dah-notice' });
      els.log = h('div', { class: 'dah-log', id: 'dah-log' });

      els.btnStart = h('button', { id: 'dah-btn-start', class: 'dah-primary', text: '启动' });
      els.btnStop = h('button', { id: 'dah-btn-stop', class: 'dah-danger', text: '停止' });
      els.btnResume = h('button', { id: 'dah-btn-resume', text: '继续播放' });
      els.btnRetry = h('button', { id: 'dah-btn-retry', text: '重试' });
      els.btnManual = h('button', { id: 'dah-btn-manual', text: '手动打开' });

      els.btnStart.addEventListener('click', function () {
        onStartClick();
      });
      els.btnStop.addEventListener('click', function () {
        onStopClick();
      });
      els.btnResume.addEventListener('click', function () {
        onResumeClick();
      });
      els.btnRetry.addEventListener('click', function () {
        onRetryClick();
      });
      els.btnManual.addEventListener('click', function () {
        onManualClick();
      });

      const body = h('div', { class: 'dah-body' }, [
        h('div', { class: 'dah-row' }, [h('div', { class: 'dah-k', text: '状态' }), els.status]),
        h('div', { class: 'dah-row' }, [h('div', { class: 'dah-k', text: '课程' }), els.course]),
        h('div', { class: 'dah-row' }, [h('div', { class: 'dah-k', text: '讲次' }), els.lecture]),
        els.notice,
        h('div', { class: 'dah-actions' }, [els.btnStart, els.btnStop, els.btnResume, els.btnRetry, els.btnManual]),
        h('div', { class: 'dah-hint', text: '点击面板标题可展开/收起日志。默认不自动播放。' }),
        els.log
      ]);

      els.panel = h('div', { id: 'dah-panel' }, [els.head, body]);
      els.head.addEventListener('click', function () {
        expanded = !expanded;
        els.panel.className = expanded ? 'dah-expanded' : 'dah-collapsed';
      });
      document.body.appendChild(els.panel);
      mounted = true;
      refreshLog();
    }

    function refreshLog() {
      if (!els.log) return;
      const tail = Log.tail(expanded ? 30 : 8);
      els.log.textContent = tail
        .map(function (l) {
          const d = new Date(l.at);
          const p = function (n) {
            return n < 10 ? '0' + n : '' + n;
          };
          return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + l.text;
        })
        .join('\n');
    }

    function statusText() {
      const task = S.task;
      if (!task) return '未启动';
      if (task.stage === 'done') return '已完成';
      if (!task.active) return '已停止';
      if (task.stage === 'blocked') return '已暂停（需处理）';
      if (S.verifyBlocked) return '已暂停（等待验证）';
      if (S.userPaused) return '已暂停（手动）';
      if (S.passive) return '待命（其他标签执行中）';
      if (S.executing) {
        if (S.page === 'player' && S.video) {
          if (S.video.ended) return '运行中（等待核验）';
          if (!S.video.paused) return '运行中（播放中）';
          return '运行中（未播放）';
        }
        return '运行中';
      }
      return '待继续';
    }

    return {
      mount: mount,
      refreshLog: refreshLog,
      update() {
        if (!mounted || !els.panel) return;
        // 每次刷新面板前先做一次提示自愈：视频真的在播就不该再显示“已暂停”提示
        syncPlayingNotice();
        const task = S.task;
        els.status.textContent = statusText();
        els.course.textContent = task && task.courseName ? task.courseName : '—';
        els.lecture.textContent = task && task.lectureTitle ? task.lectureTitle : '—';
        if (S.notice && S.notice.text) {
          els.notice.className = 'dah-notice dah-' + (S.notice.kind || 'info');
          els.notice.textContent = S.notice.text;
        } else {
          els.notice.className = 'dah-notice';
          els.notice.textContent = '';
        }
        const inactive = !task || !task.active;
        els.btnStart.style.display = inactive || task.stage === 'blocked' || S.passive ? '' : 'none';
        els.btnStop.style.display = task && task.active ? '' : 'none';
        els.btnResume.style.display =
          S.page === 'player' && task && task.active && (S.userPaused || S.autoplayBlocked || S.verifyBlocked || (S.video && S.video.paused))
            ? ''
            : 'none';
        els.btnRetry.style.display = task && task.active && task.stage === 'blocked' ? '' : 'none';
        els.btnManual.style.display =
          task && task.active && task.stage === 'blocked' && task.blocked && task.blocked.manual ? '' : 'none';
        refreshLog();
      },
      setNotice(kind, text) {
        S.notice = { kind: kind, text: text };
        this.update();
      }
    };
  })();

  /* ======================================================================
   * 15. 租约（多标签互斥）与任务状态
   * ==================================================================== */

  function tabId() {
    try {
      if (typeof sessionStorage !== 'undefined') {
        const saved = sessionStorage.getItem('dah.v1.tabId');
        if (saved && /^tab-[A-Za-z0-9_-]+$/.test(saved)) return saved;
      }
      const name = String(window.name || '');
      const m = /(?:^|\|)dah-tab=([A-Za-z0-9_-]+)/.exec(name);
      if (m) {
        try {
          if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('dah.v1.tabId', m[1]);
        } catch (e0) {}
        return m[1];
      }
      const id = 'tab-' + Math.random().toString(36).slice(2, 8);
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('dah.v1.tabId', id);
      } catch (e1) {}
      if (name !== 'dah_course_worker') {
        window.name = name ? name + '|dah-tab=' + id : 'dah-tab=' + id;
      }
      return id;
    } catch (e) {
      return 'tab-unknown';
    }
  }

  /**
   * 脚本主动暂停：记录“原因 + 时间 + 序号”，供 handlePause 识别这次 pause 是不是自己发起的。
   * 绝不再用单个 bool，否则“脚本暂停 + 站点初始化暂停”交错时会误判成用户暂停。
   */
  /** 登记/刷新「我的课程」标签页与「讲次/播放」工作标签页在线状态（带 3s 节流，支持 force 立即刷新） */
  function touchTabPresence(closed, force) {
    const now = Date.now();
    if (!closed && !force && now - (S.lastPresenceTouchAt || 0) < 3000) return;
    S.lastPresenceTouchAt = now;
    if (S.page === 'course') {
      Store.writeCourseTab({ tabId: S.tabId, at: now, url: location.href, closed: !!closed });
      if (!closed && now - (S.lastCourseKeepAliveAt || 0) >= (CFG.courseKeepAliveMs || 180000)) {
        S.lastCourseKeepAliveAt = now;
        try {
          const img = new Image();
          img.src = '/favicon.ico?_dah_ka=' + now;
        } catch (e) {}
      }
    } else if (S.page === 'lecture' || S.page === 'player') {
      Store.writeWorkerTab({ tabId: S.tabId, page: S.page, at: now, url: location.href, closed: !!closed });
    }
  }

  /** 脚本受控同页跳转与刷新：跳转前标记 navigatingInternal，防止 beforeunload 误把工作标签标记为 closed 导致课程页自跳双开 */
  function navigateSameTab(url) {
    if (!url) return;
    S.navigatingInternal = true;
    touchTabPresence(false, true);
    location.assign(url);
  }

  function reloadSameTab() {
    S.navigatingInternal = true;
    touchTabPresence(false, true);
    location.reload();
  }

  function isCourseTabAlive() {
    const ct = Store.readCourseTab();
    return Boolean(ct && !ct.closed && ct.at && Date.now() - ct.at < 95000);
  }

  function isWorkerTabAlive() {
    const wt = Store.readWorkerTab();
    return Boolean(wt && !wt.closed && wt.at && Date.now() - wt.at < 95000);
  }

  /**
   * 同步维护 video 上的后台保活标记，供页面防暂停守卫识别“当前是否处于脚本受控播放态”。
   * 关键（v1.1.0 修复）：在视频尚未加载出有效时长（duration=未知）且未实际起播时绝不加锁，
   * 避免 Video.js 初始化期间调用的内部 pause() 被主世界守卫拦截而卡在 0s 暂停态！
   */
  function setKeepPlayingMark(on) {
    if (!S.video || typeof S.video.setAttribute !== 'function') return;
    try {
      const readyAndPlaying =
        on &&
        !S.endedHandled &&
        !PlayerAdapter.nearVideoEnd(S.video) &&
        typeof S.video.duration === 'number' &&
        isFinite(S.video.duration) &&
        S.video.duration > 0 &&
        (!S.video.paused || (S.video.currentTime || 0) > 0.5);
      if (readyAndPlaying) {
        S.video.setAttribute('data-dah-keep-playing', '1');
      } else {
        S.video.removeAttribute('data-dah-keep-playing');
        if (!on) StepTimers.clear('bgResume');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  function scriptPause(reason) {
    const cause = reason || 'script';
    setKeepPlayingMark(false);
    if (!S.video || S.video.paused) {
      S.pauseCause = cause;
      S.pauseAt = Date.now();
      return;
    }
    S.pauseCause = cause;
    S.pauseAt = Date.now();
    S.lastScriptPause = { reason: cause, at: S.pauseAt, seq: ++S.scriptPauseSeq };
    S.expectPause = { video: S.video, at: S.pauseAt, reason: cause };
    try {
      S.video.pause();
    } catch (e) {
      /* 忽略 */
    }
  }

  function leaseStatus() {
    const lease = Store.readLease();
    const now = Date.now();
    if (!lease || !lease.owner) return { state: 'free', lease: lease };
    if (lease.released) return { state: 'free', lease: lease, mine: lease.owner === S.tabId };
    const isHiddenSelf =
      lease.owner === S.tabId &&
      !TEST_OVERRIDE.leaseTtlMs &&
      (document.visibilityState === 'hidden' || !!document.hidden);
    const effectiveTtl = isHiddenSelf ? Math.max(CFG.leaseTtlMs, CFG.bgLeaseTtlMs || 90000) : CFG.leaseTtlMs;
    if (Core.leaseIsFree(lease, now, effectiveTtl)) {
      return { state: lease.owner === S.tabId ? 'mine-stale' : 'free', lease: lease };
    }
    if (lease.owner === S.tabId) return { state: 'mine', lease: lease };
    return { state: 'other', lease: lease };
  }

  /** 执行权是不是“可能归我”：mine / mine-stale（自己因节流过期）；别的标签新鲜持有才是 other */
  function leaseMayBeMine() {
    const st = leaseStatus();
    return st.state === 'mine' || st.state === 'mine-stale';
  }

  /**
   * 申请执行权：写入后等一小段时间读回校验，确认“现在确实是我持有”。
   * @returns {Promise<boolean>} 是否确认本页持有执行权
   */
  async function acquireLease() {
    if (leaseStatus().state === 'other') return false;
    const nonce = 'n-' + Math.random().toString(36).slice(2, 10);
    for (let round = 0; round < 3; round++) {
      Store.writeLease({
        owner: S.tabId,
        at: Date.now(),
        released: false,
        nonce: nonce,
        runId: S.task && S.task.runId ? S.task.runId : '',
        page: S.page
      });
      for (let i = 0; i < 2; i++) {
        await Utils.sleep(CFG.leaseSettleMs);
        const back = Store.readLease();
        if (back && back.released) {
          S.lease = back;
          Log.info('执行权已随“停止”释放，本页不再启动。');
          return false;
        }
        if (back && back.owner === S.tabId) {
          const fresh = {
            owner: S.tabId,
            at: Date.now(),
            released: false,
            nonce: back.nonce || nonce,
            runId: S.task && S.task.runId ? S.task.runId : (back.runId || ''),
            page: S.page
          };
          Store.writeLease(fresh);
          S.lease = fresh;
          return true;
        }
        if (back && back.owner && !Core.leaseIsFree(back, Date.now(), CFG.leaseTtlMs)) {
          S.lease = back;
          Log.warn('申请执行权失败：执行权已被其它标签持有（owner=' + back.owner + '）。');
          return false;
        }
      }
      Log.warn('申请执行权的读回校验未稳定（第 ' + (round + 1) + ' 次尝试，可能与其他写入并发），重试。');
    }
    Log.warn('申请执行权失败：多次读回都没能确认本页持有执行权。');
    return false;
  }

  function renewLease() {
    if (S.handedOff) return false; // 交棒后绝不能再把 released 改回 false
    // 自己的租约过期（mine-stale）也允许续上：后台节流不等于别人接管
    if (!leaseMayBeMine()) return false;
    const cur = Store.readLease() || {};
    Store.writeLease({
      owner: S.tabId,
      at: Date.now(),
      released: false,
      nonce: cur.nonce || '',
      runId: cur.runId || '',
      page: S.page
    });
    return true;
  }

  /** 交棒给即将打开的新标签：先释放租约，再立刻停掉本页执行器（心跳随之停止） */
  function releaseLeaseForHandoff() {
    const st = leaseStatus();
    if (st.state === 'mine' || st.state === 'mine-stale') {
      const cur = Store.readLease() || {};
      Store.writeLease({
        owner: S.tabId,
        at: Date.now(),
        released: true,
        nonce: cur.nonce || '',
        runId: cur.runId || '',
        page: S.page,
        note: 'handoff'
      });
      S.lease = Store.readLease();
    }
    S.handedOff = true;
    S.executing = false;
    S.playIntent = false;
    StepTimers.clearAll();
    Log.info('已释放执行权并停手，等待新标签接手。');
    UI.update();
  }

  function releaseLease() {
    if (!leaseMayBeMine()) return;
    const cur = Store.readLease() || {};
    Store.writeLease({
      owner: S.tabId,
      at: Date.now(),
      released: true,
      nonce: cur.nonce || '',
      runId: cur.runId || '',
      page: S.page
    });
    S.lease = Store.readLease();
  }

  function readTask() {
    const task = Store.readTask();
    S.task = task;
    return task;
  }

  function writeTask(task) {
    if (!task) return;
    task.updatedAt = Date.now();
    Store.writeTask(task);
    S.task = task;
  }

  /** 写任务前做代次校验：只有当前这一轮能写，旧步骤不能覆盖新一轮任务 */
  function commitTask(task) {
    if (!task) return false;
    if (S.runId && task.runId && task.runId !== S.runId) {
      Log.warn('忽略过期任务写入（runId 不匹配）。');
      return false;
    }
    const cur = Store.readTask();
    if (cur && cur.runId && S.runId && cur.runId !== S.runId) {
      Log.warn('忽略过期任务写入（存储里已是新一轮任务）。');
      return false;
    }
    writeTask(task);
    return true;
  }

  /** 统一闸门：执行权 + 代次 + 任务有效性；任何有副作用的动作前都要过这一关 */
  function canAct() {
    if (!S.booted || S.handedOff || !S.executing) return false;
    // 自己的租约因后台节流过期（mine-stale）不算失去执行权：否则一次延迟就会把本页永久判死。
    // 真正的仲裁仍在写租约时（acquireLease 的写后回读）进行。
    const ls = leaseStatus();
    if (ls.state !== 'mine' && ls.state !== 'mine-stale') return false;
    const task = Store.readTask();
    if (!task || !task.active) return false;
    if (S.runId && task.runId !== S.runId) return false;
    if (task.stage === 'blocked' || task.stage === 'done' || task.stage === 'stopped') return false;
    S.task = task;
    return true;
  }

  /** 异步回调统一包装：代次/所有权变了就直接放弃，不写回任何状态 */
  function guard(fn) {
    return function () {
      if (!canAct()) return;
      try {
        fn();
      } catch (e) {
        fail('执行过程出错：' + (e && e.message ? e.message : e), '可点“重试”。');
      }
    };
  }

  function isExecutor() {
    return canAct();
  }

  /* ---- 账号指纹：只保存短哈希，不保存账号原文 ---- */
  function hashShort(text) {
    let h = 2166136261;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * 尽力识别当前账号：URL 的 accountId 优先；课程主页 URL 不带 accountId 时，
   * 只能按真实调用签名取账号 —— watchCourse 的 args[3]、watchCourseStart 的 args[6]，
   * 并且必须像账号（较长数字串）。**不扫描“第一个像 id 的参数”**（那会拿到年份 2026）。
   * 识别不到返回空串，表示“未知”，未知就不许据此认定同号、也不许暂停别人的页面。
   */
  function detectAccountId() {
    const fromUrl = PlayerAdapter.urlParams().accountId;
    if (CourseCall.isAccount(fromUrl)) return fromUrl;
    if (S.page !== 'course') return '';
    const rows = Dom.qsa('table tr');
    for (let i = 0; i < rows.length; i++) {
      const info = CourseAdapter.callOf(rows[i]);
      if (info && CourseCall.isAccount(info.account)) return info.account;
    }
    return '';
  }

  function accountTagOf(accountId) {
    return accountId ? hashShort(accountId) : '';
  }

  function currentAccountTag() {
    return accountTagOf(detectAccountId());
  }

  /* ---- 任务期望页：刷新/新标签只允许在“任务预期的那一页、那个账号”自动接手 ---- */
  function setExpect(exp) {
    const task = readTask();
    if (!task) return;
    task.expect = Object.assign({ page: '', cwID: '', lectureID: '', accountTag: '' }, exp || {});
    commitTask(task);
  }

  function pageName(p) {
    return p === 'course' ? '课程列表' : p === 'lecture' ? '讲次列表' : p === 'player' ? '播放页' : '未知页面';
  }

  /**
   * 返回 {ok, reason}。原则：**身份未知就不接手**。
   * - 页面类型必须与预期一致；
   * - 账号：任务有指纹时必须能确认且一致（确认不了 = 不接手）；
   * - 讲次列表页：用页面上显示的课程名称核对目标课程（读不到名称时，只接受“刚由本任务点开”的交接记录）；
   * - 播放页：cwID 与 lectureID 都必须读得到、且与任务记录一致（预期里缺 id 也算无法确认）。
   */
  function expectCheck(task) {
    const exp = task && task.expect;
    if (!exp) return { ok: true, reason: '' };
    if (exp.page && exp.page !== S.page) {
      return { ok: false, reason: '任务预期在「' + pageName(exp.page) + '」继续，本页是「' + pageName(S.page) + '」' };
    }
    const params = PlayerAdapter.urlParams();
    if (exp.accountTag) {
      const tag = currentAccountTag();
      if (tag && tag !== exp.accountTag) return { ok: false, reason: '本页账号与任务发起账号不同' };
      if (!tag) {
        const sameTabHandoff = task.handoff && task.handoff.from === S.tabId && task.handoff.toPage === S.page;
        const playerIdsMatch =
          S.page === 'player' &&
          exp.cwID &&
          params.cwID === exp.cwID &&
          params.lectureID &&
          params.lectureID === String(exp.lectureID || '').replace(/^L:/, '');
        if (!sameTabHandoff && !playerIdsMatch) {
          return { ok: false, reason: '本页无法确认账号，为避免串号不自动执行' };
        }
      }
    }
    if (S.page === 'lecture') {
      const want = exp.courseName || task.courseName || '';
      const got = LectureAdapter.courseName();
      const cwMatch = Boolean(exp.cwID && params.cwID && exp.cwID === params.cwID);
      if (want && got) {
        if (Core.normalizeTitle(got) !== Core.normalizeTitle(want) && !cwMatch) {
          return { ok: false, reason: '本页课程是「' + got + '」，任务目标是「' + want + '」' };
        }
        return { ok: true, reason: '' };
      }
      if (cwMatch) {
        return { ok: true, reason: '' };
      }
      return { ok: false, reason: '本页或任务记录里缺少课程名称，无法确认是不是目标课程' };
    }
    if (S.page === 'player') {
      if (!exp.cwID) return { ok: false, reason: '任务没有记录目标课程 id，无法确认这个播放页' };
      if (!params.cwID) return { ok: false, reason: '播放页地址里读不到 cwID，无法确认目标课程' };
      if (params.cwID !== exp.cwID) return { ok: false, reason: '本页课程与任务目标课程不一致' };
      const wantLecture = String(exp.lectureID || (task.pending && task.pending.lectureKey) || '').replace(/^L:/, '');
      if (!wantLecture) return { ok: false, reason: '任务没有记录目标讲次 id，无法确认这个播放页' };
      if (!params.lectureID) return { ok: false, reason: '播放页地址里读不到 lectureID，无法确认目标讲次' };
      if (params.lectureID !== wantLecture) return { ok: false, reason: '本页讲次与任务目标讲次不一致' };
      return { ok: true, reason: '' };
    }
    return { ok: true, reason: '' };
  }

  /* ======================================================================
   * 16. 面板按钮与全局动作
   * ==================================================================== */

  /**
   * 写面板提示。source 只有“会随状态失效的提示”才传（目前是后台来源不明的暂停）。
   * 传了 source 的提示，会在视频真的恢复播放时被 syncPlayingNotice() 换回播放中提示。
   */
  function notice(kind, text, source) {
    S.notice = { kind: kind, text: text };
    S.noticeSource = source || '';
    UI.update();
  }

  /**
   * 提示自愈：如果视频此刻**确实在播**、没有人工暂停/验证，就把“后台来源不明暂停”这条
   * 已经过期的提示换回播放中提示。
   * 只改提示文字，**不会**调用 play()（绝不靠“假装恢复了”来掩盖问题）；
   * 视频真的还暂停着就什么都不做，保留原提示。
   * 直接在 UI.update() 里执行（只在 S.notice 上改字），不会递归调用 UI.update。
   */
  function syncPlayingNotice() {
    if (S.noticeSource !== 'hidden-pause') return;
    if (!S.video || S.video.paused || S.video.ended) return;
    if (S.userPaused || S.verifyBlocked) return;
    S.notice = { kind: 'info', text: '正在播放，等待本讲结束…' };
    S.noticeSource = '';
  }

  async function onStartClick() {
    touchTabPresence(false, true);
    if (S.page === 'course' && !isWorkerTabAlive() && !window.__DAH_FORCE_POPUP__) {
      installSameTabNavGuard();
      try {
        document.dispatchEvent(new CustomEvent('dah-open-worker-tab'));
      } catch (e) {}
    }
    const task = readTask();
    if (task && task.active && task.stage !== 'blocked' && task.stage !== 'done' && task.stage !== 'stopped') {
      // 已有运行中的任务：本页尝试接管（仅当执行权空闲/已过期）
      if (!(await acquireLease())) {
        notice(
          'warn',
          '另一个标签仍在执行（执行权未过期）。如那个标签已关闭，请稍等约 ' + Math.round(CFG.leaseTtlMs / 1000) + ' 秒再点“启动”。'
        );
        return;
      }
      S.passive = false;
      S.handedOff = false;
      S.runId = task.runId;
      becomeExecutor('已接管任务', { leaseAcquired: true });
      return;
    }
    // 全新任务（含“已停止”后重新启动）：换 runId，旧回调全部作废
    const params = PlayerAdapter.urlParams();
    const fresh = {
      v: 1,
      runId: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      active: true,
      stage: 'course',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      courseKey: '',
      courseName: '',
      cwID: '',
      lectureKey: '',
      lectureTitle: '',
      pending: null,
      blocked: null,
      skipped: {},
      completedLectures: {},
      autoReplayCounts: {},
      waitingForCourseUrl: false,
      nextCourseRedirectUrl: '',
      courseRelayConsumedBy: '',
      courseRelayConsumedAt: 0,
      courseHops: 0,
      userPaused: false,
      accountTag: currentAccountTag(),
      expect: { page: 'course', cwID: '', lectureID: '', accountTag: currentAccountTag() },
      sourcePage: S.page
    };
    if (S.page === 'player') {
      fresh.stage = 'lecture';
      fresh.cwID = params.cwID || '';
      fresh.lectureKey = params.lectureID ? 'L:' + params.lectureID : '';
      fresh.lectureTitle = '当前播放页（' + (params.lectureID || '未知讲次') + '）';
      fresh.expect = {
        page: 'player',
        cwID: params.cwID || '',
        lectureID: params.lectureID || '',
        courseName: '',
        accountTag: fresh.accountTag
      };
    } else if (S.page === 'lecture') {
      fresh.stage = 'lecture';
      fresh.cwID = params.cwID || '';
      fresh.courseName = LectureAdapter.courseName() || '';
      fresh.lectureKey = '';
      fresh.expect = {
        page: 'lecture',
        cwID: params.cwID || '',
        lectureID: '',
        courseName: fresh.courseName,
        accountTag: fresh.accountTag
      };
    }
    // 先抢执行权，再写任务：两个标签同时点“启动”时，输的一方绝不会覆盖赢家的任务
    if (!(await acquireLease())) {
      notice('warn', '另一个标签刚刚先拿到了执行权，本页不启动（避免两个标签同时播放）。如那个标签已关闭，请稍等约 ' + Math.round(CFG.leaseTtlMs / 1000) + ' 秒再点“启动”。');
      return;
    }
    writeTask(fresh);
    S.runId = fresh.runId;
    S.handedOff = false;
    S.stopSilenced = false;
    S.endedHandled = false;
    S.playRetries = 0;
    Log.info('用户点击启动，任务 ' + fresh.runId + ' 开始（账号指纹 ' + (fresh.accountTag || '未知') + '）。');
    S.passive = false;
    becomeExecutor('开始运行', { leaseAcquired: true });
  }

  function onStopClick() {
    const task = readTask() || {};
    task.active = false;
    task.stage = 'stopped';
    task.stoppedAt = Date.now();
    task.stopBy = S.tabId;
    writeTask(task);
    halt('已停止（由你手动停止）', { keepNotice: true, pauseVideo: true });
    // 允许“停止遗留”逻辑对随后才绑定/打开的目标播放页再暂停一次（无关页面不受影响）
    S.stopSilenced = false;
    releaseLease();
    StepTimers.clearAll();
    notice('info', '已停止。播放已暂停，不会再自动继续。');
    Log.info('用户点击停止，任务停止。');
  }

  async function onResumeClick() {
    const task = readTask();
    if (!task || !task.active) {
      notice('warn', '当前没有运行中的任务。请点“启动”。');
      return;
    }
    if (S.page !== 'player') {
      notice('info', '本页不是播放页，无需“继续播放”。');
      return;
    }
    const verify = PlayerAdapter.verificationOverlay();
    if (verify) {
      S.verifyBlocked = true;
      notice('warn', '页面上仍有验证弹窗，请先完成验证（不要关闭弹窗），再点“继续播放”。');
      return;
    }
    S.verifyBlocked = false;
    S.userPaused = false;
    S.autoplayBlocked = false;
    task.userPaused = false;
    writeTask(task);
    if (!isExecutor()) {
      if (!(await acquireLease())) {
        notice('warn', '另一个标签正在执行，本页无法播放。');
        return;
      }
      S.runId = task.runId;
      S.handedOff = false;
      becomeExecutor('接管并继续播放', { leaseAcquired: true });
    } else {
      ensurePlaying();
    }
  }

  /**
   * 这次“手动打开”的上下文是否真的成立：同一轮任务、同一个来源页面、同一个账号、同一门课/同一讲。
   * 只要有一项对不上就原地不动（不跳课、不改身份、不在别人的标签/账号里执行）。
   * @returns {{ok: boolean, why: string}}
   */
  function manualContextOk(task, manual) {
    if (!task || !task.active) return { ok: false, why: '任务已经不在运行' };
    if (task.stage !== 'blocked') return { ok: false, why: '任务当前不是暂停状态' };
    if (!manual) return { ok: false, why: '这次暂停没有记录人工恢复入口' };
    if (manual.page && manual.page !== S.page) {
      return { ok: false, why: '本页不是暂停时所在的页面（要在' + (manual.page === 'lecture' ? '讲次列表' : '课程列表') + '里点）' };
    }
    if (manual.runId && task.runId && manual.runId !== task.runId) return { ok: false, why: '任务已经换成新一轮' };
    const tag = currentAccountTag();
    if (!tag || !task.accountTag || tag !== task.accountTag) return { ok: false, why: '本页登录的账号与任务不一致' };
    if (manual.courseKey && task.courseKey && manual.courseKey !== task.courseKey) {
      return { ok: false, why: '任务要处理的课程已经变了' };
    }
    if (manual.lectureKey && task.lectureKey && manual.lectureKey !== task.lectureKey) {
      return { ok: false, why: '任务要处理的讲次已经变了' };
    }
    return { ok: true, why: '' };
  }

  /**
   * 按记录里的身份，从**当前页面重新解析**同一个入口（刷新过也不怕）。
   * 不按名字猜、不换别的课/别的讲：找不到就明确失败，让用户去原站点手动打开。
   * @returns {{el: Element, toPage: string}|{why: string}}
   */
  function resolveManualEntry(task, manual) {
    if (manual.page === 'lecture') {
      const rows = LectureAdapter.parse();
      if (!rows) return { why: '当前页面读不到讲次列表' };
      const row = findLectureRow(rows, manual.lectureKey || task.lectureKey, manual.lectureTitle || task.lectureTitle);
      if (!row) return { why: '讲次列表里已经找不到原来那一讲' };
      if (!row.play || !row.play.el) return { why: '原来那一讲已经没有播放入口' };
      return { el: row.play.el, toPage: 'player' };
    }
    if (manual.page === 'course') {
      const courses = CourseAdapter.parse();
      if (!courses) return { why: '当前页面读不到课程列表' };
      const key = manual.courseKey || task.courseKey;
      let hit = null;
      for (let i = 0; i < courses.length; i++) {
        if (courses[i].key === key) {
          hit = courses[i];
          break;
        }
      }
      if (!hit) return { why: '课程列表里已经找不到原来那门课（脚本不会改去别的课程）' };
      if (!hit.entry || !hit.entry.el) return { why: '原来那门课已经没有可用入口' };
      return { el: hit.entry.el, toPage: 'lecture' };
    }
    return { why: '暂停记录里的来源页面无法识别' };
  }

  /**
   * “手动打开”（B）：浏览器拦截新标签时，用**用户这次点击的手势**再点一次入口。
   * 关键：点击必须在用户点击的**同步调用栈**里完成（中间不能 await，否则激活丢失、仍被拦）；
   * 所以这里同步落 handoff 记录 + 同步点入口，再异步有界等待新页面的持久 ack。
   * 等不到就再次暂停（有界、不无限等待、不改浏览器设置、不猜 URL）。
   */
  function onManualClick() {
    const task = readTask();
    if (!task || !task.active || task.stage !== 'blocked') {
      notice('warn', '当前没有需要手动打开的暂停任务。');
      return;
    }
    const manual = (task.blocked && task.blocked.manual) || null;
    if (!manual) {
      notice('info', '这次暂停不需要手动打开页面，请按提示处理或点“重试”。');
      return;
    }
    // 上下文闸门：别的标签/别的账号/别的页面点了都不许动
    const ctxOk = manualContextOk(task, manual);
    if (!ctxOk.ok) {
      Log.warn('忽略“手动打开”：' + ctxOk.why + '。');
      notice('warn', '本页不能手动继续：' + ctxOk.why + '。任务保持暂停，未做任何跳转。');
      UI.update();
      return;
    }
    const ls = leaseStatus();
    if (ls.state === 'other') {
      notice('warn', '另一个标签正在执行，本页不能动作。');
      return;
    }
    // 入口一律从当前 DOM 重新解析：S.manualEl 只当“同一节点”的加速器，不作为身份依据
    const resolved = resolveManualEntry(task, manual);
    if (!resolved.el) {
      // 找不到原入口：保留身份与暂停态，明确告诉用户去原站点手动打开（绝不改跳别的课）
      Log.warn('手动打开失败：' + resolved.why + '。');
      fail(
        '仍然找不到原来的' + (manual.page === 'lecture' ? '讲次播放入口' : '课程入口') + '。',
        '请到原站点手动打开《' + (task.courseName || task.courseKey || '原课程') + '》' +
          (manual.page === 'lecture' ? '的这一讲' : '的讲次列表') +
          '，然后点“重试”；脚本不会改去别的课程。',
        { manual: manual }
      );
      return;
    }
    const el = resolved.el;
    S.manualEl = el;
    const toPage = resolved.toPage;
    // 先清掉暂停态（同步）：否则 ack 等待会立刻把 blocked 当成“任务已暂停”而作废
    task.stage = manual.page === 'lecture' ? 'lecture' : 'course';
    task.blocked = null;
    if (!commitTask(task)) {
      notice('warn', '任务状态已变化，请重新点“启动”。');
      return;
    }
    S.runId = task.runId;
    S.handedOff = false;
    S.executing = true;
    S.passive = false;
    // —— 以下是同步段：仍在用户手势里 ——
    const handoffId = startHandoff(task.runId, { toPage: toPage, entry: manual.entry || '' });
    if (!handoffId) {
      notice('warn', '任务状态已变化，请重新点“启动”。');
      return;
    }
    notice('info', '手动继续：正在用你这次点击重新打开目标页面…');
    Log.info('用户点“手动打开”，重试入口（' + (manual.entry || '?') + '，来自页面 ' + (manual.page || '?') + '）。');
    const clicked = performEntryClick(el, toPage);
    // —— 异步段：等 ack / 有界失败 ——
    (async function () {
      const outcome = clicked === 'failed' ? 'click-failed' : await awaitHandoffAck(handoffId, task.runId, toPage === 'player' ? buildDirectPlayerUrl(el) : '');
      if (outcome === 'handoff') {
        notice('info', '已按你的点击打开目标页面，任务交给新标签继续。');
        UI.update();
        return;
      }
      if (outcome === 'aborted') {
        Log.info('手动打开的等待已作废：任务已停止/已换一轮/已被新页面推进。');
        return;
      }
      const failHint = '仍然没有打开目标页面。请允许本站弹窗（地址栏右侧），或手动打开这一页后点“重试”。';
      return recoverFromFailedNavigation(
        task.runId,
        handoffId,
        outcome === 'click-failed' ? '手动打开失败：点击入口没有成功。' : '手动打开后目标页面仍未出现。',
        failHint,
        manual
      );
    })();
  }

  /**
   * 重试：只重试**同一门课 / 同一讲次 / 同一次 pending 核验**，不跳课，也不把 task.expect
   * 改成“当前这一页的身份”来掩盖走错页。先取执行权、再校验 runId。
   * 当前页不是任务目标时：保持原记录不动，回到课程列表用原课程 key 重新打开（入口可再点）。
   */
  async function onRetryClick() {
    const before = readTask();
    if (!before) {
      notice('warn', '没有可重试的任务，请点“启动”。');
      return;
    }
    if (before.stage === 'stopped') {
      notice('info', '任务已停止。要重新开始请点“启动”。');
      return;
    }
    if (before.stage !== 'blocked') {
      notice('info', '当前任务没有处于“已暂停（需处理）”状态，无需重试。');
      return;
    }
    const runId0 = before.runId;
    const wasPending = !!before.pending;
    const wasLecture = before.lectureKey || '';
    if (!(await acquireLease())) {
      notice('error', '无法获得执行权（另一个标签正持有）。请稍后再点“重试”。');
      return;
    }
    const task = readTask();
    if (!task || task.runId !== runId0) {
      Log.info('重试已作废：任务已换成新一轮。');
      return;
    }
    const params = PlayerAdapter.urlParams();
    const wantCw = expectedCwId(task);
    // 判断“本页是不是任务目标”只看记录（pending / lectureKey），不看 stage —— 点重试时 stage 正是 blocked
    const onTarget = wasPending
      ? S.page === 'lecture' && !!wantCw && params.cwID === wantCw && sameCourseName(task.courseName)
      : wasLecture
        ? S.page === 'player' && !!wantCw && params.cwID === wantCw && sameLecture(params.lectureID, wasLecture)
        : S.page === 'course';

    task.active = true;
    task.blocked = null;
    task.userPaused = false;
    // 同一次核验重试：核验次数重新计数（否则一重试就立刻又到上限）
    if (wasPending && task.pending) task.pending.checks = 0;
    if (wasPending) task.stage = 'confirm';
    else if (wasLecture) task.stage = 'lecture';
    else task.stage = 'course';
    task.lectureKey = wasLecture;
    if (!wasLecture) task.lectureTitle = '';
    S.runId = task.runId;
    S.handedOff = false;
    S.endedHandled = false;
    S.playRetries = 0;
    S.passive = false;

    if (onTarget) {
      if (!commitTask(task)) return;
      Log.info('用户点击重试（在本页）：继续同一门课「' + (task.courseName || '未记录') + '」' + (wasPending ? '，重新核验同一讲次 `' + (task.pending && task.pending.lectureTitle) + '`' : '') + '。');
      notice('info', '重试：在本页继续处理「' + (task.courseName || '当前课程') + '」' + (wasPending ? '，重新核验同一讲次。' : '。'));
      becomeExecutor('重试', { leaseAcquired: true });
      return;
    }

    // 不在目标页：**不改 task.expect 的身份**，只记下“回课程列表重新打开原课程”这条路由。
    if (task.courseKey) task.retryCourseKey = task.courseKey;
    task.retryRoute = 'course-list';
    if (!commitTask(task)) return;
    Log.info('用户点击重试，但本页不是任务目标（' + pageName(S.page) + '）：回到课程列表重新打开原课程「' + (task.courseName || task.courseKey || '未记录') + '」。');
    notice('info', '重试：本页不是任务目标，正在回到课程列表重新打开原课程…');
    StepTimers.setTimeout(
      'retryBack',
      function () {
        const cur = Store.readTask();
        if (!cur || cur.runId !== runId0 || !cur.active || cur.retryRoute !== 'course-list') return;
        if (S.page === 'player' && params.cwID) {
          navigateToLectureList();
          return;
        }
        if (isCourseTabAlive()) {
          cur.stage = 'course';
          cur.waitingForCourseUrl = true;
          cur.nextCourseRedirectUrl = '';
          cur.courseRelayConsumedBy = '';
          cur.expect = { page: 'course', cwID: '', lectureID: '', accountTag: cur.accountTag || '' };
          writeTask(cur);
          releaseLeaseForHandoff();
          return;
        }
        notice('warn', '未检测到已打开的「我的课程」页面（为避免跳转至北京首页已取消裸跳），请手动切换到「我的课程」页面后点“启动”。');
      },
      300
    );
  }

  /** 任务记录里的目标课程 id：优先 task.cwID，其次 expect.cwID（两条都来自真实讲次页/播放页地址） */
  function expectedCwId(task) {
    if (!task) return '';
    return String(task.cwID || (task.expect && task.expect.cwID) || '');
  }

  function sameLecture(urlLectureId, lectureKey) {
    const want = String(lectureKey || '').replace(/^L:/, '');
    return !!want && String(urlLectureId || '') === want;
  }

  function sameCourseName(courseName) {
    if (!courseName) return false;
    const got = LectureAdapter.courseName();
    return !!got && Core.normalizeTitle(got) === Core.normalizeTitle(courseName);
  }

  /* ======================================================================
   * 17. 执行器生命周期
   * ==================================================================== */

  async function becomeExecutor(reason, opts) {
    if (S.becomingExecutor) return;
    opts = opts || {};
    S.becomingExecutor = true;
    try {
      if (!opts.leaseAcquired) {
        let ok = false;
        try {
          ok = await acquireLease();
        } catch (e) {
          ok = false;
        }
        if (!ok) {
          S.passive = true;
          const cur = Store.readTask();
          if (!cur || !cur.active) {
            notice('info', '任务已停止，本页不启动（视频若被站点自动播放会立即暂停）。');
          } else {
            notice('warn', '未能取得执行权（可能另一个标签刚刚接手），本页只显示状态。');
          }
          UI.update();
          return;
        }
      }
    } finally {
      S.becomingExecutor = false;
    }
    const latestTask = readTask();
    if (!latestTask || !latestTask.active) {
      Log.warn('执行器未启动：任务已不在运行。');
      return;
    }
    if (S.page === 'lecture') {
      const params = PlayerAdapter.urlParams();
      if (params.cwID) {
        if (latestTask.cwID !== params.cwID) {
          Log.info('已确认目标课程页，绑定实际课程 id：' + params.cwID + '（取自讲次列表地址）。');
        }
        latestTask.cwID = params.cwID;
        if (!latestTask.courseName) {
          const gotName = LectureAdapter.courseName();
          if (gotName) latestTask.courseName = gotName;
        }
        if (!latestTask.expect || latestTask.expect.page === 'lecture') {
          latestTask.expect = Object.assign({}, latestTask.expect || {}, { page: 'lecture', cwID: params.cwID });
        }
        commitTask(latestTask);
      }
    }
    S.executing = true;
    S.passive = false;
    S.handedOff = false;
    S.stallCount = 0;
    ackHandoff(latestTask);
    S.lastProgressSec = -1;
    S.lastProgressAt = Date.now();
    StepTimers.clearAll();
    Timers.every('heartbeat', heartbeat, CFG.heartbeatMs);
    notice('info', (reason || '运行') + '：正在处理当前页面…');
    Log.info('本标签开始执行（' + (reason || '运行') + '），页面类型 ' + S.page + '，runId=' + (S.runId || '?') + '。');
    runStep().catch(function (e) {
      if (!canAct()) return;
      fail('执行过程出错：' + (e && e.message ? e.message : e), '可点“重试”重新开始。');
    });
  }

  function heartbeat() {
    touchTabPresence(false);
    if (S.handedOff || !S.executing) return;
    if (S.page === 'player') refreshBoundVideo();
    if (S.page === 'player' && !S.endedHandled && !PlayerAdapter.nearVideoEnd(S.video)) {
      PlayerAdapter.dismissIdlePrompt();
    }
    const st = leaseStatus();
    if (st.state === 'other') {
      halt('执行权已被其它标签持有，本页停止执行。', { pauseVideo: true, cause: 'lost' });
      S.passive = true;
      notice('info', '执行权已由另一个标签持有，本页停止执行（避免两个标签同时播放）。');
      UI.update();
      return;
    }
    if (st.state === 'mine-stale') {
      if (S.leaseRecovering) return;
      const now = Date.now();
      if (now - S.leaseRecoverAt < CFG.leaseRecoverMs) {
        renewLease();
        return;
      }
      S.leaseRecoverAt = now;
      S.leaseRecovering = true;
      renewLease();
      Log.warn('自己的执行权已过期（可能是后台标签被节流），尝试重新取得执行权。');
      acquireLease()
        .catch(function () {
          return false;
        })
        .then(function (ok) {
          S.leaseRecovering = false;
          S.leaseRecoverAt = Date.now();
          if (!ok) {
            const after = leaseStatus();
            if (after.state === 'other') {
              S.passive = true;
              halt('执行权已由另一个标签持有。', { pauseVideo: true, cause: 'lost' });
              notice('info', '执行权已由另一个标签持有，本页停止执行（避免两个标签同时播放）。');
            } else {
              Log.warn('这次没能重新取得执行权（可能与其他写入并发），保持本页执行者身份，下个心跳继续尝试。');
            }
            UI.update();
            return;
          }
          renewLease();
          S.passive = false;
          const wasSoft = S.pauseCause === 'lost' || S.pauseCause === 'hidden-pause' || S.pauseCause === 'hidden-unknown';
          if (wasSoft) S.pauseCause = '';
          Log.info('已重新取得执行权，继续执行。');
          if (S.page === 'player' && !S.endedHandled && !PlayerAdapter.nearVideoEnd(S.video)) {
            PlayerAdapter.dismissIdlePrompt();
            if (
              !S.userPaused &&
              !S.verifyBlocked &&
              !S.autoplayBlocked &&
              (wasSoft || (S.playIntent && S.video && (S.video.paused || PlayerAdapter.isUiPaused(S.video)) && !S.video.ended))
            ) {
              ensurePlaying(true);
            }
          }
          UI.update();
        });
      return;
    }
    renewLease();
    if (S.page === 'player' && canAct() && S.playIntent && !S.endedHandled && !S.userPaused && !S.verifyBlocked) {
      if (PlayerAdapter.nearVideoEnd(S.video)) {
        if (S.video && (S.video.ended || S.video.paused)) handleEnded();
        return;
      }
      const now = Date.now();
      if (now - S.lastMouseKeepAliveAt >= (CFG.mouseKeepAliveMs || 25000)) {
        S.lastMouseKeepAliveAt = now;
        PlayerAdapter.simulateMouseActivity();
      }
      if (!S.autoplayBlocked && S.video && !S.video.ended) {
        const uiPaused = PlayerAdapter.isUiPaused(S.video);
        const stuckAtStart =
          (!isFinite(S.video.duration) || (S.video.currentTime || 0) < 0.2) &&
          S.lastProgressAt > 0 &&
          now - S.lastProgressAt > 3500;
        if (S.video.paused || uiPaused || stuckAtStart) {
          ensurePlaying(uiPaused || stuckAtStart);
        }
      }
    }
  }

  /** 本地停手（不改全局任务状态） */
  function halt(reason, opts) {
    opts = opts || {};
    S.executing = false;
    S.playIntent = false;
    StepTimers.clearAll();
    if (opts.pauseVideo) scriptPause(opts.cause || 'script');
    if (!opts.keepNotice && reason) notice('info', reason);
    UI.update();
  }

  /** 失败并暂停任务；过期代次的写入会被丢弃，避免旧步骤覆盖新一轮任务 */
  function fail(reason, hint, opts) {
    const task = readTask();
    if (!task) return;
    if (S.runId && task.runId && task.runId !== S.runId) {
      Log.warn('忽略过期的失败写入（runId 不匹配）：' + reason);
      return;
    }
    if (!task.active) {
      Log.warn('任务已不在运行，忽略失败写入：' + reason);
      return;
    }
    task.stage = 'blocked';
    const manual = opts && opts.manual ? Object.assign({}, opts.manual) : null;
    if (manual) {
      // 人工恢复入口必须自带身份：哪一轮、哪次交接、哪个账号
      manual.runId = manual.runId || task.runId;
      manual.handoffId = manual.handoffId || S.handoffId || '';
      manual.accountTag = manual.accountTag || task.accountTag || '';
    }
    task.blocked = { reason: reason, hint: hint || '', at: Date.now(), page: S.page, runId: task.runId, manual: manual };
    writeTask(task);
    S.executing = false;
    S.playIntent = false;
    StepTimers.clearAll();
    scriptPause('stop');
    Log.error('任务暂停：' + reason + (hint ? '（' + hint + '）' : ''));
    notice('error', reason + (hint ? ' ' + hint : ''));
    UI.update();
  }

  /** 全部结束 */
  function finishRun(reason) {
    const task = readTask();
    if (!task) return;
    if (S.runId && task.runId && task.runId !== S.runId) return;
    task.active = false;
    task.stage = 'done';
    task.finishedAt = Date.now();
    task.result = reason;
    writeTask(task);
    S.executing = false;
    S.playIntent = false;
    StepTimers.clearAll();
    scriptPause('stop');
    releaseLease();
    Log.info('任务结束：' + reason);
    notice('info', reason);
    UI.update();
  }

  /** 响应其它标签改动（v1.1.0 防重入、防双开竞争与工作标签中继确认） */
  function onStoreChange(kind) {
    if (kind === 'poll') touchTabPresence(false);
    const task = Store.readTask();
    S.task = task;
    const st = leaseStatus();

    if (!task || !task.active) {
      if (S.executing) {
        halt('任务已被停止。', { pauseVideo: true });
        notice('info', '任务已在别处停止，本页已停手。');
      }
      if (task && task.stage === 'done') notice('info', task.result || '任务已完成。');
      enforceSilence();
      UI.update();
      return;
    }

    if (task.stage === 'blocked') {
      if (S.executing) {
        halt('任务已暂停（需处理）。', { pauseVideo: true });
        const b = task.blocked || {};
        notice('error', (b.reason || '任务已暂停') + (b.hint ? ' ' + b.hint : ''));
      }
      enforceSilence();
      UI.update();
      return;
    }

    // 1) 在「我的课程」页：仅在尚未尝试绑定当前 courseName 时匹配一次 courseKey，防止重复解析与重复写存储
    if (S.page === 'course' && task.courseName && !task.courseKey && S.lastBoundCourseName !== task.courseName) {
      S.lastBoundCourseName = task.courseName;
      const courses = CourseAdapter.parse();
      if (courses) {
        const wantName = Core.normalizeTitle(task.courseName);
        for (let i = 0; i < courses.length; i++) {
          if (Core.normalizeTitle(courses[i].name) === wantName && courses[i].key) {
            task.courseKey = courses[i].key;
            if (!task.accountTag) task.accountTag = currentAccountTag();
            writeTask(task);
            break;
          }
        }
      }
    }

    // 2) 在「讲次列表/播放页」：当常驻的「我的课程」页已解析出下一门课的讲次列表 URL（nextCourseRedirectUrl）时，写入消费回执并立即同页跳转！
    if ((S.page === 'lecture' || S.page === 'player') && task.nextCourseRedirectUrl) {
      const nextUrl = String(task.nextCourseRedirectUrl).trim();
      task.nextCourseRedirectUrl = '';
      task.waitingForCourseUrl = false;
      task.courseRelayConsumedBy = S.tabId;
      task.courseRelayConsumedAt = Date.now();
      writeTask(task);
      StepTimers.clear('waitCourseRelay');
      Log.info('收到「我的课程」中继的下一门课讲次列表地址，正在同页跳转：' + nextUrl);
      notice('info', '正在跳转至下一门课程「' + (task.courseName || '') + '」的讲次列表…');
      navigateSameTab(nextUrl);
      return;
    }

    // 3) 在常驻的「我的课程」页：当上一门课全部讲次播完交回课程阶段（task.stage === 'course' 且 lease 已释放）时，单路唤醒挑选下一门课！
    if (
      S.page === 'course' &&
      !S.executing &&
      !S.becomingExecutor &&
      !S.leaseRecovering &&
      task.stage === 'course' &&
      task.expect &&
      task.expect.page === 'course' &&
      st.state !== 'other'
    ) {
      S.handedOff = false;
      S.passive = false;
      Log.info('「我的课程」页面检测到上一门课已完成，自动接手挑选下一门未完成课程…');
      resumeOrIdle();
      return;
    }

    if (st.state === 'other' && S.executing) {
      halt('执行权已由另一个标签持有。', { pauseVideo: true, cause: 'lost' });
      S.passive = true;
      notice('info', '执行权已由另一个标签持有，本页停止执行（避免两个标签同时播放）。');
      enforceSilence();
      UI.update();
      return;
    }

    enforceSilence();
    UI.update();
  }

  /**
   * 是否应该静默本页播放器。
   * 只在“存在用户启动的有效任务 + 与本任务同账号 + 本页不是当前目标讲次的执行标签”时成立；
   * 没有有效任务（未启动/已停止/已完成）时完全不干扰用户手动播放。
   * 只暂停，不改音量/静音设置。
   */
  /**
   * “停止遗留”：任务是被用户停掉的、且本页正是这次运行预期接管的那一页时，
   * 允许暂停一次本页的视频（覆盖“在别的标签点停止，而目标播放页刚打开、视频还没绑定”的情形）。
   * 只认 60 秒内的停止、只认同一账号、只认同一讲次；无关页面（别的讲次/别的账号/没有任务）一律不碰。
   */
  function stopSilenceActive() {
    const task = Store.readTask();
    if (!task || task.active) return false;
    if (task.stage !== 'stopped') return false;
    if (!task.stoppedAt || Date.now() - task.stoppedAt > 60000) return false;
    if (S.page !== 'player') return false;
    // 身份未知就不碰：必须能确认是同一账号，且能确认是本任务的目标课程/讲次
    const tag = currentAccountTag();
    if (!tag || !task.accountTag || tag !== task.accountTag) return false;
    const params = PlayerAdapter.urlParams();
    if (!params.cwID || !params.lectureID) return false;
    const wantCw = expectedCwId(task);
    if (!wantCw || params.cwID !== wantCw) return false;
    // E：原来这里用了未定义的 exp（靠 task.lectureKey 短路掩盖）；改成显式读 task.expect
    const exp = task.expect || {};
    const wantLecture = String(task.lectureKey || exp.lectureID || '').replace(/^L:/, '');
    if (!wantLecture) return false;
    return params.lectureID === wantLecture;
  }

  /**
   * 是否应该静默本页播放器。
   * 关键区别：**自己的租约过期**（多半是后台标签被节流）不算“别的标签在播”，不能因此暂停自己；
   * 只有“别的标签新鲜持有执行权”或“本页根本不是任务的目标讲次”才静默。
   */
  function shouldSilence() {
    if (S.page !== 'player' || !S.video) return false;
    const task = Store.readTask();
    if (!task || !task.active) return false;
    if (task.stage === 'stopped' || task.stage === 'done') return false;
    if (task.verifyBlocked) return false;
    // 必须能确认账号且与本任务一致；账号未知时一律不暂停（避免误伤别人的页面）
    const tag = currentAccountTag();
    if (!task.accountTag || !tag || task.accountTag !== tag) return false;
    const params = PlayerAdapter.urlParams();
    const targetId = String(task.lectureKey || '').replace(/^L:/, '');
    const isTarget = !!(targetId && params.lectureID && params.lectureID === targetId);
    const st = leaseStatus();
    // 目标讲次：只有“别的标签确实新鲜持有执行权”才让位；mine / mine-stale / free 都继续播
    if (isTarget) return st.state === 'other';
    // 非目标讲次：本页不是任务目标，无论执行权在谁手上都不该出声
    return true;
  }

  function enforceSilence() {
    if (!S.video) return;
    // 停止遗留：只作用一次，之后用户手动播放不再干预
    if (!S.stopSilenced && stopSilenceActive()) {
      S.stopSilenced = true;
      scriptPause('stop');
      Log.info('本页是刚被停止的那次运行的目标页，已暂停本页视频（未改动音量/静音）。');
      notice('info', '任务已停止：本页视频已暂停，不会再自动继续。');
      UI.update();
      return;
    }
    if (!shouldSilence()) {
      S.silencedReason = '';
      return;
    }
    if (S.video.paused) return;
    scriptPause('lost');
    if (S.silencedReason !== 'on') {
      S.silencedReason = 'on';
      Log.info('本页不是当前任务的执行标签或不是目标讲次，已暂停本页播放（未改动音量/静音）。');
      notice('info', '本页不是当前任务的执行标签，已暂停本页播放；任务在另一个标签里继续。');
      UI.update();
    }
  }

  /**
   * 页面加载时：只有“用户已启动、未停止”且“本页正是任务预期的那一页/那个账号”才自动接手。
   */
  function resumeOrIdle() {
    const task = readTask();
    if (!task) {
      notice('info', '未启动。点“启动”后开始依次播放未完成讲次。');
      UI.update();
      return;
    }
    S.userPaused = !!task.userPaused;
    if (!task.active) {
      notice('info', task.stage === 'done' ? task.result || '任务已完成。' : '任务已停止。点“启动”开始新一轮。');
      UI.update();
      return;
    }
    if (S.executing || S.becomingExecutor) return;
    if (task.stage === 'blocked') {
      const b = task.blocked || {};
      const chkBlocked = expectCheck(task);
      if (b.manual && task.expect && task.expect.page === S.page && chkBlocked.ok) {
        task.stage = S.page === 'player' ? 'lecture' : S.page;
        task.blocked = null;
        commitTask(task);
        Log.info('检测到目标页面已就绪，自动解除跳转等待暂停并继续执行。');
      } else {
        notice('error', (b.reason || '任务已暂停') + (b.hint ? ' ' + b.hint : ''));
        UI.update();
        return;
      }
    }
    if (!S.page) return;

    // “重试 → 回课程列表重新打开原课程”这条路由：只在课程列表页兑现一次。
    // 只改“预期在哪一页继续”，课程名/cwID/courseKey/待核验讲次都原样保留。
    if (task.retryRoute === 'course-list' && S.page === 'course') {
      task.retryRoute = '';
      task.expect = Object.assign({}, task.expect || {}, { page: 'course' });
      commitTask(task);
      Log.info('按“重试”的路由，在课程列表重新打开原课程「' + (task.courseName || task.courseKey || '未记录') + '」。');
    }

    const chk = expectCheck(task);
    if (!chk.ok) {
      S.passive = true;
      notice('info', '本页不自动接手：' + chk.reason + '。任务仍在别处；如需在本页重新开始，请点“启动”。');
      Log.info('未自动接手：' + chk.reason);
      UI.update();
      return;
    }

    const st = leaseStatus();
    if (st.state === 'other') {
      S.passive = true;
      const age = Math.max(0, Math.round((Date.now() - (st.lease.at || 0)) / 1000));
      notice('info', '任务由另一个标签执行中（' + age + ' 秒前心跳）。本页只显示状态，不播放。');
      UI.update();
      return;
    }
    S.runId = task.runId;
    S.handedOff = false;
    Log.info('检测到未完成任务（' + task.stage + '），本页与任务预期一致，接手继续。');
    becomeExecutor('刷新/打开页面后恢复');
  }

  /* ======================================================================
   * 18. 步骤分发
   * ==================================================================== */

  async function runStep() {
    if (!isExecutor()) return;
    const task = readTask();
    if (!task || !task.active) {
      halt('任务已停止。');
      return;
    }
    if (task.stage === 'blocked') {
      halt('任务已暂停（需处理）。', { pauseVideo: true });
      return;
    }
    if (S.page === 'course') return stepCourse(task);
    if (S.page === 'lecture') return stepLecture(task);
    if (S.page === 'player') return stepPlayer(task);
    return fail('当前页面不是受支持的页面。', '请在课程列表、讲次列表或播放页上点“启动”。');
  }

  /* ---------------------------------------------------------------------
   * 18.1 课程列表：挑一门未完成的课，点真实入口进讲次列表
   * ------------------------------------------------------------------- */
  async function stepCourse(task) {
    const rows = await Utils.waitUntil(function () {
      return CourseAdapter.parse();
    }, CFG.domWaitMs);
    if (!isExecutor()) return;
    if (!rows) {
      if (Pages.loginSuspect()) {
        return fail('登录状态可能已失效，没有读到课程列表。', '请重新登录东奥学习平台后再点“启动”。');
      }
      return fail('未能在课程页面识别到课程列表。', '页面结构可能已变化，或页面还没加载出来；可稍后点“重试”。');
    }
    Log.info(
      '课程列表共 ' + rows.length + ' 门；状态：' +
        rows
          .map(function (r) {
            return '「' + r.name + '」' + (r.evaluation.complete ? '已完成' : '未完成');
          })
          .join('、')
    );
    // 有“待核验”的讲次时，重试只允许**重开同一门课**去核验那一讲：绝不换课，也不换 pending。
    const keepPending = !!task.pending;
    let pick = null;
    let retryRow = null;
    // 重试时指定的原课程（key 稳定，不清空）
    if (task.retryCourseKey) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].key === task.retryCourseKey) {
          retryRow = rows[i];
          break;
        }
      }
    }

    if (retryRow) {
      // 行内已标“完成”也照开：还有待核验记录时，必须回原课程核验原讲，不能拿它去判断“这门课不用管了”
      pick = retryRow;
      Log.info(
        '重试：重新打开原课程「' + retryRow.name + '」（key=' + retryRow.key + '）' +
          (keepPending ? '，继续核验待核验的讲次。' : '。') +
          (retryRow.evaluation.complete ? '注：课程行现在显示已完成，但仍按待核验记录回原课核对。' : '')
      );
    } else if (task.retryCourseKey) {
      // 原课程不在列表里：**保留原课程/讲次/pending/expect 并暂停**，不换课、不结束任务
      Log.warn(
        '重试：课程列表里找不到原课程（key=' + task.retryCourseKey + '）' +
          (keepPending ? '，且还有待核验的讲次。保留原记录并暂停，不换课。' : '。')
      );
      return fail(
        '课程列表里找不到刚才那门课（key=' + task.retryCourseKey + '）' +
          (keepPending ? '，而这一讲还在等待核验' : '') + '，已暂停。',
        '请手动打开这门课的讲次列表，确认这一讲的进度后再点“重试”；脚本不会改去播别的课程。'
      );
    } else if (keepPending) {
      // 有待核验记录却没有指定原课程：同样不能随便挑一门课，否则会把旧 pending 带到新课上
      return fail(
        '这一讲还在等待核验，但任务里没有记录它属于哪门课，已暂停。',
        '请手动打开原课程的讲次列表确认进度；脚本不会拿旧记录去打开别的课程。'
      );
    }

    if (!pick) {
      // 只有在“没有待核验讲次”的普通重试 / 正常推进时，才允许按顺序挑下一门
      pick = Core.pickNextCourse(rows, task.courseKey || '', task.skipped || {});
      if (!pick) return finishRun('全部课程都已判定完成，任务结束。');
      task.retryCourseKey = '';
      task.retryRoute = '';
    }
    if (!pick.entry) {
      // 入口缺失：保留身份并暂停（原课程/讲次/pending 都不动）
      return fail('课程「' + pick.name + '」行内没有找到“听课详情/课程名称”入口，已暂停。', '请在页面上手动打开这门课的讲次列表，然后点“重试”。');
    }
    if (retryRow) {
      task.retryCourseKey = '';
      task.retryRoute = '';
    }
    const runId = task.runId;
    // 在这里才动课程身份：进入原课程/新课程之后，courseKey/courseName 与 pending 的归属保持一致
    task.courseKey = pick.key;
    task.courseName = pick.name;
    task.stage = keepPending ? 'confirm' : 'course';
    if (!keepPending) task.pending = null;
    task.courseHops = (task.courseHops || 0) + 1;
    task.accountTag = task.accountTag || currentAccountTag();
    // 目标讲次页的 cwID 现在还不知道（课程行的参数里没有它，选课 id 也不是它）：
    // 交给讲次列表页用 document.title 确认课程名之后再绑定真实 cwID。
    task.expect = {
      page: 'lecture',
      cwID: '',
      lectureID: '',
      courseName: pick.name,
      courseKey: pick.key,
      accountTag: task.accountTag || ''
    };
    if (!commitTask(task)) return;
    UI.update();
    notice('info', '正在打开《' + pick.name + '》的讲次列表（点击页面上的“' + pick.entry.kind + '”）。');
    Log.info('打开课程《' + pick.name + '》入口类型：' + pick.entry.kind + '，key=' + pick.key + '。');
    if (task.courseHops > CFG.maxCourseHops) {
      return fail('课程跳转次数过多（' + task.courseHops + ' 次），为避免死循环已暂停。', '请手动检查课程列表状态。');
    }
    S.hadWorkerRelay = Boolean(task.waitingForCourseUrl || isWorkerTabAlive());
    const outcome = await clickEntryAndHandoff(pick.entry.el, runId, { toPage: 'lecture', entry: pick.entry.kind });
    if (outcome === 'handoff') {
      S.passive = true;
      notice('info', '已在新的标签页打开《' + pick.name + '》讲次列表，任务交给新标签继续。');
      UI.update();
      return;
    }
    if (outcome === 'aborted') {
      Log.info('等待跳转期间任务已停止/已换新一轮，本页不再动作。');
      return;
    }
    const h1 = S.handoffId;
    if (outcome === 'click-failed') {
      return recoverFromFailedNavigation(runId, h1, '点击课程“' + pick.entry.kind + '”入口失败。', '请手动打开这门课的讲次列表，然后点“重试”。', {
        page: 'course',
        entry: pick.entry.kind,
        courseKey: pick.key
      });
    }
    return recoverFromFailedNavigation(
      runId,
      h1,
      '点击“' + pick.entry.kind + '”后页面没有打开讲次列表。',
      '常见原因：浏览器拦下了新标签页。请点面板上的“手动打开”，或允许本站弹窗后点“重试”。',
      { page: 'course', entry: pick.entry.kind, courseKey: pick.key }
    );
  }

  /**
   * 交棒第一步（同步）：写持久交接记录 + 释放执行权。必须在“点入口”之前完成。
   * @returns {string} handoffId；'' 表示失败（任务已变）
   */
  function startHandoff(runId, opts) {
    opts = opts || {};
    const task0 = Store.readTask();
    if (!task0 || !task0.active) return '';
    if (runId && task0.runId && task0.runId !== runId) return '';
    // A：把这次交接写成“持久记录”——新页面接手后写 ack，旧页面据此确认，而不是只看瞬时租约
    const handoffId = 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    S.handoffId = handoffId;
    task0.handoff = {
      id: handoffId,
      runId: runId || task0.runId,
      from: S.tabId,
      fromPage: S.page,
      at: Date.now(),
      toPage: opts.toPage || '',
      entry: opts.entry || '',
      ack: null
    };
    if (!commitTask(task0)) return '';
    releaseLeaseForHandoff(); // 先释放，新标签才能立刻接手；同时本页停手、停心跳
    return handoffId;
  }

  /**
   * 注入主世界导航守卫（v1.1.0 双模架构）：
   * 1. 在「讲次列表」页（data-dah-nav-mode="same-tab"）：将 videoPlay() 转为当前标签页同页跳转；
   * 2. 在「我的课程」页（data-dah-nav-mode="capture-course"）：捕获 watchCourse 生成的讲次列表 URL，通过 GM 存储中继给工作标签页，绝不让「我的课程」自跳导致双标签竞争。
   */
  function installSameTabNavGuard() {
    if (document.getElementById('dah-nav-guard')) return;
    try {
      const s = document.createElement('script');
      s.id = 'dah-nav-guard';
      s.textContent = [
        '(function(){',
        '  if (window.__DAH_NAV_GUARD__) return;',
        '  window.__DAH_NAV_GUARD__ = true;',
        '  var origOpen = window.open;',
        '  function navMode() {',
        '    return (document.documentElement && document.documentElement.getAttribute("data-dah-nav-mode")) || "";',
        '  }',
        '  function isSameTabMode() { return navMode() === "same-tab"; }',
        '  function isCaptureCourseMode() { return navMode() === "capture-course"; }',
        '  function markTriggered(u) {',
        '    try {',
        '      if (document.documentElement) {',
        '        document.documentElement.setAttribute("data-dah-same-tab-triggered", "1");',
        '        if (u) document.documentElement.setAttribute("data-dah-same-tab-url", String(u));',
        '      }',
        '    } catch (e) {}',
        '  }',
        '  function recordCapturedCourseUrl(rawUrl) {',
        '    try {',
        '      var u = rawUrl ? String(rawUrl).trim() : "";',
        '      if (!u || u === "about:blank" || /^javascript:/i.test(u)) return;',
        '      var full = u;',
        '      try { full = new URL(u, window.location.href).toString(); } catch (e0) {}',
        '      if (document.documentElement) {',
        '        document.documentElement.setAttribute("data-dah-captured-url", full);',
        '        document.documentElement.setAttribute("data-dah-same-tab-triggered", "1");',
        '      }',
        '      if (window.__DAH_WORKER_WIN__ && !window.__DAH_WORKER_WIN__.closed) {',
        '        try { window.__DAH_WORKER_WIN__.location.href = full; } catch (e1) {}',
        '      }',
        '    } catch (e) {}',
        '  }',
        '  document.addEventListener("dah-open-worker-tab", function() {',
        '    try {',
        '      if (!window.__DAH_WORKER_WIN__ || window.__DAH_WORKER_WIN__.closed) {',
        '        window.__DAH_WORKER_WIN__ = origOpen ? origOpen.call(window, "about:blank", "dah_course_worker") : null;',
        '      }',
        '    } catch (e) {}',
        '  });',
        '  function makeProxyWin(forCapture) {',
        '    var handleUrl = function(u) {',
        '      if (!u) return;',
        '      if (forCapture) recordCapturedCourseUrl(u);',
        '      else { markTriggered(u); window.location.assign(String(u)); }',
        '    };',
        '    var loc = {',
        '      assign: function(u){ handleUrl(u); },',
        '      replace: function(u){ handleUrl(u); },',
        '      reload: function(){}',
        '    };',
        '    Object.defineProperty(loc, "href", {',
        '      get: function(){ return window.location.href; },',
        '      set: function(u){ handleUrl(u); }',
        '    });',
        '    var dummyDoc = (document.implementation && document.implementation.createHTMLDocument) ? document.implementation.createHTMLDocument("") : {};',
        '    var w = { closed: false, focus: function(){}, close: function(){}, blur: function(){}, document: dummyDoc };',
        '    Object.defineProperty(w, "location", {',
        '      get: function(){ return loc; },',
        '      set: function(u){ handleUrl(u); }',
        '    });',
        '    return w;',
        '  }',
        '  window.open = function(url, target, features) {',
        '    if (!window.__DAH_FORCE_POPUP__) {',
        '      if (isCaptureCourseMode()) {',
        '        var u0 = url ? String(url).trim() : "";',
        '        if (u0 && u0 !== "about:blank" && !/^javascript:/i.test(u0)) {',
        '          recordCapturedCourseUrl(u0);',
        '        } else {',
        '          markTriggered("capture-proxy");',
        '        }',
        '        return makeProxyWin(true);',
        '      }',
        '      if (isSameTabMode()) {',
        '        var u = url ? String(url).trim() : "";',
        '        if (u && u !== "about:blank" && !/^javascript:/i.test(u)) {',
        '          markTriggered(u);',
        '          window.location.assign(u);',
        '          return makeProxyWin(false);',
        '        }',
        '        markTriggered("proxy");',
        '        return makeProxyWin(false);',
        '      }',
        '    }',
        '    var win = origOpen ? origOpen.apply(this, arguments) : null;',
        '    if (!win && (isSameTabMode() || isCaptureCourseMode())) {',
        '      var u2 = url ? String(url).trim() : "";',
        '      if (isCaptureCourseMode()) {',
        '        if (u2) recordCapturedCourseUrl(u2);',
        '        return makeProxyWin(true);',
        '      }',
        '      if (u2 && u2 !== "about:blank" && !/^javascript:/i.test(u2)) {',
        '        markTriggered(u2);',
        '        window.location.assign(u2);',
        '      }',
        '      return makeProxyWin(false);',
        '    }',
        '    return win;',
        '  };',
        '  if (typeof HTMLFormElement !== "undefined" && HTMLFormElement.prototype && HTMLFormElement.prototype.submit) {',
        '    var origSubmit = HTMLFormElement.prototype.submit;',
        '    HTMLFormElement.prototype.submit = function() {',
        '      try {',
        '        if (!window.__DAH_FORCE_POPUP__) {',
        '          if (isCaptureCourseMode()) {',
        '            var method = String(this.method || "GET").toUpperCase();',
        '            if (method === "GET" && this.action) {',
        '              var fu = new URL(this.action, window.location.href);',
        '              var fd = new FormData(this);',
        '              fd.forEach(function(v, k){ fu.searchParams.set(k, String(v)); });',
        '              recordCapturedCourseUrl(fu.toString());',
        '              return;',
        '            }',
        '            this.target = "dah_course_worker";',
        '            markTriggered(this.action || "form");',
        '          } else if (isSameTabMode()) {',
        '            this.target = "_self";',
        '            markTriggered(this.action || "form");',
        '          }',
        '        }',
        '      } catch (e) {}',
        '      return origSubmit.apply(this, arguments);',
        '    };',
        '  }',
        '  document.addEventListener("submit", function(e) {',
        '    try {',
        '      if (!window.__DAH_FORCE_POPUP__ && e && e.target) {',
        '        if (isCaptureCourseMode()) {',
        '          e.target.target = "dah_course_worker";',
        '          markTriggered(e.target.action || "form");',
        '        } else if (isSameTabMode()) {',
        '          e.target.target = "_self";',
        '          markTriggered(e.target.action || "form");',
        '        }',
        '      }',
        '    } catch (err) {}',
        '  }, true);',
        '  document.addEventListener("click", function(e) {',
        '    try {',
        '      if (typeof window.videoPlay === "function" && document.documentElement) {',
        '        document.documentElement.setAttribute("data-dah-has-videoplay", "1");',
        '      }',
        '      if (window.__DAH_FORCE_POPUP__) return;',
        '      var a = e && e.target && e.target.closest ? e.target.closest("a") : null;',
        '      if (!a) return;',
        '      if (isSameTabMode() && a.getAttribute("target") === "_blank") {',
        '        a.setAttribute("target", "_self");',
        '      } else if (isCaptureCourseMode() && a.getAttribute("target") === "_blank") {',
        '        var rawHref = a.getAttribute("href") || "";',
        '        if (rawHref && !/^javascript:/i.test(rawHref) && !/^#/.test(rawHref)) {',
        '          e.preventDefault();',
        '          recordCapturedCourseUrl(rawHref);',
        '        }',
        '      }',
        '    } catch (err) {}',
        '  }, true);',
        '})();'
      ].join('\n');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* 忽略 */
    }
  }

  function setSameTabNavMode(mode) {
    try {
      if (!document.documentElement) return;
      if (mode) {
        installSameTabNavGuard();
        const m = typeof mode === 'string' ? mode : (S.page === 'course' ? 'capture-course' : 'same-tab');
        document.documentElement.setAttribute('data-dah-nav-mode', m);
        document.documentElement.removeAttribute('data-dah-same-tab-triggered');
        document.documentElement.removeAttribute('data-dah-captured-url');
      } else {
        document.documentElement.removeAttribute('data-dah-nav-mode');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  function buildDirectPlayerUrl(el) {
    if (S.page !== 'lecture') return '';
    const params = PlayerAdapter.urlParams();
    const task = Store.readTask() || {};
    let cwID = params.cwID || task.cwID || (task.expect && task.expect.cwID) || '';
    let lectureID = (task.expect && task.expect.lectureID) || String(task.lectureKey || '').replace(/^L:/, '');
    if (el && el.getAttribute) {
      const args = Core.extractCallArgs(el.getAttribute('onclick') || '', 'videoPlay');
      if (args && args.length >= 2) {
        if (!cwID && args[0]) cwID = args[0];
        if (args[1]) lectureID = args[1];
      } else if (args && args.length === 1 && args[0]) {
        lectureID = args[0];
      }
    }
    if (!cwID || !lectureID || /^T:/.test(lectureID)) return '';
    try {
      const u = new URL('/cwweb/videoShow/video/videoPlay', location.origin);
      u.searchParams.set('cwID', String(cwID));
      u.searchParams.set('lectureID', String(lectureID).replace(/^L:/, ''));
      u.searchParams.set('platformCode', PLATFORM_CODE);
      if (params.accountId) u.searchParams.set('accountId', String(params.accountId));
      return u.toString();
    } catch (e) {
      return '';
    }
  }

  function performEntryClick(el, toPage) {
    S.manualEl = el;
    const mode = S.page === 'course' ? 'capture-course' : 'same-tab';
    setSameTabNavMode(mode);
    const nav = toPage ? Dom.sameTabNav(el, toPage) : null;
    if (nav) {
      if (S.page === 'course') {
        Log.info('捕获到课程直达链接，通过跨标签中继打开讲次列表：' + nav.pathname);
        try {
          document.documentElement.setAttribute('data-dah-captured-url', nav.href);
          document.documentElement.setAttribute('data-dah-same-tab-triggered', '1');
        } catch (e) {}
        return 'clicked';
      }
      Log.info('入口自带链接，按同页跳转打开：' + nav.pathname + '（避免新标签被拦截）。');
      try {
        document.documentElement.setAttribute('data-dah-same-tab-triggered', '1');
      } catch (e) {}
      navigateSameTab(nav.href);
      return 'nav';
    }
    try {
      const a = el && el.closest ? el.closest('a') : el && el.tagName === 'A' ? el : null;
      if (a && a.getAttribute('target') === '_blank' && !window.__DAH_FORCE_POPUP__ && S.page !== 'course') {
        a.setAttribute('target', '_self');
      }
    } catch (e) {}
    const ok = Dom.click(el);
    if (!ok) setSameTabNavMode(false);
    return ok ? 'clicked' : 'failed';
  }

  async function awaitHandoffAck(handoffId, runId, fallbackUrl) {
    if (!handoffId) {
      setSameTabNavMode(false);
      return 'aborted';
    }
    const t0 = Date.now();
    let fallbackUsed = false;
    let relayedCourseUrl = false;
    let relayIssuedAt = 0;
    const baseFallbackDelay = typeof CFG.sameTabDirectFallbackMs === 'number' ? CFG.sameTabDirectFallbackMs : 1800;
    while (Date.now() - t0 < CFG.handoffWaitMs) {
      await Utils.sleep(120);
      const cur = Store.readTask();
      if (!cur || !cur.active) {
        setSameTabNavMode(false);
        return 'aborted';
      }
      if (runId && cur.runId !== runId) {
        setSameTabNavMode(false);
        return 'aborted';
      }
      if (cur.stage === 'blocked' || cur.stage === 'done' || cur.stage === 'stopped') {
        setSameTabNavMode(false);
        return 'aborted';
      }
      const h = cur.handoff || {};
      if (h.id === handoffId && h.ack) {
        setSameTabNavMode(false);
        Log.info('新页面已确认接手（handoff ' + handoffId + '，by ' + (h.ack.by || '?') + '）。');
        return 'handoff';
      }
      if (h.id && h.id !== handoffId) {
        setSameTabNavMode(false);
        Log.info('本次交接等待已作废：任务已推进到新的交接（' + h.id + '）。');
        return 'handoff';
      }
      if (S.page === 'course' && document.documentElement) {
        if (!relayedCourseUrl) {
          const capUrl = document.documentElement.getAttribute('data-dah-captured-url') || '';
          if (capUrl) {
            relayedCourseUrl = true;
            relayIssuedAt = Date.now();
            cur.nextCourseRedirectUrl = capUrl;
            cur.waitingForCourseUrl = false;
            cur.courseRelayConsumedBy = '';
            Store.writeTask(cur);
            Log.info('已从「我的课程」捕获目标讲次列表地址并下发中继：' + capUrl);
          }
        } else {
          if (cur.courseRelayConsumedBy || !cur.nextCourseRedirectUrl) {
            S.hadWorkerRelay = true;
          }
          const capUrl2 = document.documentElement.getAttribute('data-dah-captured-url') || '';
          if (
            !S.hadWorkerRelay &&
            !isWorkerTabAlive() &&
            !cur.courseRelayConsumedBy &&
            capUrl2 &&
            Date.now() - relayIssuedAt >= 1800 &&
            !window.__DAH_FORCE_POPUP__
          ) {
            Log.info('未检测到独立工作标签页接手，使用当前页跳转至讲次列表。');
            navigateSameTab(capUrl2);
            setSameTabNavMode(false);
            return 'handoff';
          }
        }
      }
      const sameTabTriggered =
        document.documentElement && document.documentElement.getAttribute('data-dah-same-tab-triggered') === '1';
      if (S.page === 'lecture' && sameTabTriggered) {
        S.navigatingInternal = true;
        touchTabPresence(false, true);
      }
      const hasSiteVideoPlay =
        document.documentElement && document.documentElement.getAttribute('data-dah-has-videoplay') === '1';
      const effectiveFallbackDelay =
        hasSiteVideoPlay && !TEST_OVERRIDE.sameTabDirectFallbackMs
          ? Math.max(baseFallbackDelay, 2000)
          : baseFallbackDelay;
      if (
        S.page === 'lecture' &&
        !sameTabTriggered &&
        !fallbackUsed &&
        fallbackUrl &&
        Date.now() - t0 >= effectiveFallbackDelay &&
        !window.__DAH_FORCE_POPUP__
      ) {
        fallbackUsed = true;
        Log.info('讲次播放入口点击后未触发新页面，自动启用同页直达播放页跳转（免弹窗拦截）。');
        try {
          document.documentElement.setAttribute('data-dah-same-tab-triggered', '1');
        } catch (e) {}
        navigateSameTab(fallbackUrl);
      }
    }
    const cur2 = Store.readTask();
    setSameTabNavMode(false);
    if (!cur2 || !cur2.active) return 'aborted';
    if (runId && cur2.runId !== runId) return 'aborted';
    if (cur2.handoff && cur2.handoff.id === handoffId && cur2.handoff.ack) return 'handoff';
    if (S.page === 'course' && relayedCourseUrl && (S.hadWorkerRelay || cur2.courseRelayConsumedBy || !cur2.nextCourseRedirectUrl || isWorkerTabAlive())) {
      Log.info('工作标签页已接收下一门课中继地址并正在加载，「我的课程」保持常驻待命。');
      return 'handoff';
    }
    if (S.page === 'lecture' && document.documentElement && document.documentElement.getAttribute('data-dah-same-tab-triggered') === '1') {
      return 'handoff';
    }
    return 'none';
  }

  async function clickEntryAndHandoff(el, runId, opts) {
    const handoffId = startHandoff(runId, opts);
    if (!handoffId) return 'aborted';
    const fallbackUrl = opts && opts.toPage === 'player' ? buildDirectPlayerUrl(el) : '';
    if (performEntryClick(el, opts && opts.toPage) === 'failed') {
      if (fallbackUrl && !window.__DAH_FORCE_POPUP__) {
        Log.info('点击讲次入口失败，改用同页直达播放页地址跳转。');
        try {
          document.documentElement.setAttribute('data-dah-same-tab-triggered', '1');
        } catch (e) {}
        navigateSameTab(fallbackUrl);
        return 'handoff';
      }
      return 'click-failed';
    }
    return awaitHandoffAck(handoffId, runId, fallbackUrl);
  }

  /**
   * 点击后没有任何跳转：仅在“仍是这一轮、任务没有被新页面推进、执行权还空着”时重新拿权并给出可操作提示。
   * A：旧导航的失败不得覆盖/阻塞已经推进的任务。
   */
  async function recoverFromFailedNavigation(runId, handoffId, reason, hint, manual) {
    /** 同一套判定，await 前后各跑一次：拿执行权期间任务可能已经被新页面推进 */
    function stale(cur) {
      if (!cur || !cur.active) return '任务已不在运行';
      if (runId && cur.runId !== runId) return '任务已换新一轮';
      if (cur.stage === 'blocked' || cur.stage === 'done' || cur.stage === 'stopped') return '任务已被其它页面推进（stage=' + cur.stage + '）';
      const h = cur.handoff || {};
      if (handoffId && h.id && h.id !== handoffId) return '任务已有更新的交接记录（' + h.id + '）';
      if (handoffId && h.id === handoffId && h.ack) return '新页面已经接手（ack 已写入）';
      if (manual && manual.courseKey && cur.courseKey && manual.courseKey !== cur.courseKey) return '任务的目标课程已变';
      if (manual && manual.lectureKey && cur.lectureKey && manual.lectureKey !== cur.lectureKey) return '任务的目标讲次已变';
      return '';
    }

    const why0 = stale(Store.readTask());
    if (why0) {
      Log.info('跳转失败的处理已作废：' + why0 + '。');
      return;
    }
    const st = leaseStatus();
    if (st.state === 'other') {
      S.passive = true;
      notice('info', '执行权已被另一个标签持有，本页不再动作。');
      return;
    }
    if (!(await acquireLease())) {
      S.passive = true;
      notice('warn', '未能重新取得执行权，本页不再动作；任务可能已被另一个标签接手。');
      return;
    }
    // 关键：await 之后必须重新比对（新页面可能刚写下 ack / 推进到下一次交接）
    const cur2 = Store.readTask();
    const why1 = stale(cur2);
    if (why1) {
      Log.info('跳转失败的处理已作废（取执行权期间任务已推进）：' + why1 + '。');
      return;
    }
    S.runId = cur2.runId;
    S.handedOff = false;
    S.executing = true;
    return fail(reason, hint, { manual: manual || null });
  }

  /** 新页面接手当前这一轮交接：写持久 ack（只有“确认是任务目标页”的页面才会走到这里） */
  function ackHandoff(task) {
    if (!task || !task.handoff) return;
    const h = task.handoff;
    if (h.ack) return;
    if (h.runId && task.runId && h.runId !== task.runId) return;
    const fresh = Store.readTask();
    if (!fresh || !fresh.active || !fresh.handoff || fresh.handoff.id !== h.id) return;
    if (fresh.handoff.ack) return;
    fresh.handoff.ack = { by: S.tabId, at: Date.now(), page: S.page };
    commitTask(fresh);
    Log.info('本页确认接手上一页移交的任务（handoff ' + h.id + '）。');
  }

  /* ---------------------------------------------------------------------
   * 18.2 讲次列表：推进下一讲，或（从播放页回来后）核验上一讲是否完成
   * ------------------------------------------------------------------- */
  async function stepLecture(task) {
    const rows = await Utils.waitUntil(function () {
      return LectureAdapter.parse();
    }, CFG.domWaitMs);
    if (!isExecutor()) return;
    if (!rows) {
      if (Pages.loginSuspect()) {
        return fail('登录状态可能已失效，没有读到讲次列表。', '请重新登录后再点“启动”。');
      }
      return fail('未能在讲次列表页识别到讲次表格。', '页面结构可能已变化，或页面还没加载出来；可点“重试”。');
    }

    if (task.stage === 'confirm' && task.pending) return confirmStep(task, rows);
    if (task.stage === 'confirm' && !task.pending) {
      task.stage = 'lecture';
      commitTask(task);
    }

    Log.info('讲次状态：' + LectureAdapter.summarize(rows));
    const target = Core.pickNextLecture(rows, task.completedLectures);
    if (!target) return courseFinished(task, rows);
    if (!target.play) {
      return fail(
        '讲次「' + target.title + '」行内没有找到播放/开始学习入口（只有下载讲义之类的链接）。',
        '请手动打开这一讲；若该讲次已无法播放，请到网站上确认它的状态。'
      );
    }

    const runId = task.runId;
    task.stage = 'lecture';
    task.lectureKey = target.key;
    task.lectureTitle = target.title;
    task.pending = null;
    task.accountTag = task.accountTag || currentAccountTag();
    task.expect = {
      page: 'player',
      cwID: PlayerAdapter.urlParams().cwID || task.cwID || '',
      lectureID: String(target.key).replace(/^L:/, ''),
      courseName: task.courseName || LectureAdapter.courseName() || '',
      accountTag: task.accountTag || ''
    };
    if (!commitTask(task)) return;
    UI.update();
    notice('info', '正在打开讲次「' + target.title + '」（' + (target.progressRaw || '无进度信息') + '）…');
    Log.info('打开讲次「' + target.title + '」，key=' + target.key + '，进度 ' + (target.progressRaw || '未知') + '。');
    const outcome = await clickEntryAndHandoff(target.play.el, runId, { toPage: 'player', entry: target.play.source || 'play' });
    if (outcome === 'handoff') {
      S.passive = true;
      notice('info', '已打开讲次「' + target.title + '」，正在进入播放页…');
      UI.update();
      return;
    }
    if (outcome === 'aborted') {
      Log.info('等待跳转期间任务已停止/已换新一轮，本页不再动作。');
      return;
    }
    const h2 = S.handoffId;
    const manual = { page: 'lecture', entry: target.play.source || 'play', lectureKey: target.key, lectureTitle: target.title };
    if (outcome === 'click-failed') {
      return recoverFromFailedNavigation(runId, h2, '点击讲次「' + target.title + '」的播放入口失败。', '请点面板上的“手动打开”，或手动打开这一讲后点“重试”。', manual);
    }
    return recoverFromFailedNavigation(
      runId,
      h2,
      '点击讲次「' + target.title + '」的播放入口后页面没有打开播放页。',
      '常见原因：浏览器拦下了新标签页。请点面板上的“手动打开”，或允许本站弹窗后点“重试”。',
      manual
    );
  }

  function findLectureRow(rows, key, title) {
    if (key) {
      for (let i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i];
    }
    if (title) {
      const want = Core.normalizeTitle(title);
      for (let i = 0; i < rows.length; i++) if (Core.normalizeTitle(rows[i].title) === want) return rows[i];
    }
    return null;
  }

  function confirmStep(task, rows) {
    const p = task.pending;
    const checks = (p.checks || 0) + 1;
    const row = findLectureRow(rows, p.lectureKey, p.lectureTitle);

    if (!row) {
      p.checks = checks;
      commitTask(task);
      Log.warn('核验第 ' + checks + ' 次：列表里找不到待核验的讲次（key=' + (p.lectureKey || '') + '）。');
      if (checks >= CFG.maxVerifyChecks) {
        return fail(
          '回到讲次列表后找不到刚才播放的讲次，无法核验完成状态。',
          '可能讲次列表结构变化或该讲次被移除；请手动确认进度后点“重试”。'
        );
      }
      const wait = CFG.retryBackoffMs[Math.min(checks - 1, CFG.retryBackoffMs.length - 1)];
      notice('warn', '第 ' + checks + ' 次核验：列表里暂时找不到该讲次，' + Math.round(wait / 1000) + ' 秒后重新加载再试。');
      StepTimers.setTimeout('reverify', guard(function () {
        reloadSameTab();
      }), wait);
      return;
    }

    const ev = row.evaluation;
    const tolSec = Core.lectureToleranceSec(row.totalSec > 0 ? row.totalSec : p.frontendDurationSec);
    const mediaDurationReached =
      !ev.complete &&
      p.frontendDurationSec > 0 &&
      row.learnedSec > 0 &&
      p.frontendDurationSec - row.learnedSec <= Math.max(tolSec, CFG.completeToleranceSec || 60);
    const detail = '已学 ' + Core.formatSec(row.learnedSec) + ' / 总 ' + Core.formatSec(row.totalSec);
    const evidenceText = mediaDurationReached
      ? '已学时长 ' +
        Core.formatSec(row.learnedSec) +
        ' 达到视频实际流时长 ' +
        Core.formatSec(p.frontendDurationSec) +
        '（目录总时长 ' +
        Core.formatSec(row.totalSec) +
        '）'
      : ev.evidence.join('；');

    Log.info(
      '核验第 ' +
        checks +
        ' 次：「' +
        row.title +
        '」' +
        detail +
        '，判定 ' +
        (ev.complete || mediaDurationReached ? '完成' : '未完成') +
        '，证据：' +
        evidenceText
    );

    if (ev.complete || mediaDurationReached) {
      task.completedLectures = task.completedLectures || {};
      if (row.key) task.completedLectures[row.key] = Date.now();
      row.completedByTask = true;
      row.evaluation = Core.evaluateLecture(row);
      task.pending = null;
      task.stage = 'lecture';
      task.lectureTitle = '';
      task.lectureKey = '';
      commitTask(task);
      notice(
        'info',
        '已核验「' + row.title + '」完成（依据：' + evidenceText + '），正在自动衔接下一讲…'
      );
      return stepLecture(task);
    }

    if (typeof p.lastLearnedSec === 'number' && row.learnedSec === p.lastLearnedSec && row.learnedSec > 0) {
      p.unchangedChecks = (p.unchangedChecks || 0) + 1;
    } else {
      p.unchangedChecks = 0;
    }
    p.lastLearnedSec = row.learnedSec;
    p.checks = checks;
    commitTask(task);

    const remainSec = row.totalSec > 0 && row.learnedSec >= 0 ? Math.max(0, row.totalSec - row.learnedSec) : -1;
    const nearSettled =
      row.totalSec > 0 &&
      row.learnedSec > 0 &&
      (remainSec <= 180 || row.learnedSec / row.totalSec >= 0.90) &&
      (p.unchangedChecks >= 1 || checks >= CFG.maxVerifyChecks);

    if (nearSettled) {
      task.completedLectures = task.completedLectures || {};
      if (row.key) task.completedLectures[row.key] = Date.now();
      row.completedByTask = true;
      row.evaluation = Core.evaluateLecture(row);
      task.pending = null;
      task.stage = 'lecture';
      task.lectureTitle = '';
      task.lectureKey = '';
      commitTask(task);
      Log.info(
        '讲次「' +
          row.title +
          '」视频已完整播放至结束且站点落库进度已稳定在 ' +
          detail +
          '（差值 ' +
          remainSec +
          ' 秒属站点结算尾差），自动标记完成并继续下一讲。'
      );
      notice('info', '讲次「' + row.title + '」已播放完毕并收敛（' + detail + '），正在自动衔接下一讲…');
      return stepLecture(task);
    }

    if (checks >= CFG.maxVerifyChecks || (p.unchangedChecks || 0) >= 2) {
      task.autoReplayCounts = task.autoReplayCounts || {};
      const maxReplays = typeof CFG.maxAutoReplaysPerLecture === 'number' ? CFG.maxAutoReplaysPerLecture : 2;
      const replays = (task.autoReplayCounts[row.key] || 0) + 1;
      if (replays <= maxReplays && row.play) {
        task.autoReplayCounts[row.key] = replays;
        task.pending = null;
        task.stage = 'lecture';
        commitTask(task);
        Log.info(
          '讲次「' +
            row.title +
            '」站点记录（' +
            detail +
            '）尚未达标，无需人工介入，自动重新进入播放页补齐剩余时长（第 ' +
            replays +
            '/' +
            maxReplays +
            ' 次自动补播）…'
        );
        notice(
          'info',
          '讲次「' + row.title + '」还差部分时长（' + detail + '），正在自动重入播放页补播，无需手动操作…'
        );
        return stepLecture(task);
      }
      task.completedLectures = task.completedLectures || {};
      if (row.key) task.completedLectures[row.key] = Date.now();
      row.completedByTask = true;
      row.evaluation = Core.evaluateLecture(row);
      task.pending = null;
      task.stage = 'lecture';
      task.lectureTitle = '';
      task.lectureKey = '';
      commitTask(task);
      Log.warn('讲次「' + row.title + '」已自动补播并播放至结束（站点固定在 ' + detail + '），自动跳过并继续下一讲。');
      notice('info', '讲次「' + row.title + '」已完成补播（' + detail + '），正在自动继续下一讲…');
      return stepLecture(task);
    }

    const wait = CFG.retryBackoffMs[Math.min(checks - 1, CFG.retryBackoffMs.length - 1)];
    notice(
      'info',
      '第 ' + checks + '/' + CFG.maxVerifyChecks + ' 次核验：正在等待站点同步最终进度（' + detail + '），' +
        Math.round(wait / 1000) + ' 秒后自动刷新讲次列表…'
    );
    StepTimers.setTimeout('reverify', guard(function () {
      reloadSameTab();
    }), wait);
  }

  function courseFinished(task, rows) {
    task.courseHops = (task.courseHops || 0) + 1;
    if (task.courseHops > CFG.maxCourseHops) {
      return fail('课程跳转次数过多（' + task.courseHops + ' 次），为避免死循环已暂停。', '请手动检查课程状态。');
    }
    task.skipped = task.skipped || {};
    const cw = PlayerAdapter.urlParams().cwID || '';
    const cName = task.courseName || LectureAdapter.courseName() || '';
    if (task.courseKey) task.skipped[task.courseKey] = Date.now();
    if (cw) task.skipped['U:' + cw] = Date.now();
    if (cName) task.skipped['N:' + Core.normalizeTitle(cName)] = Date.now();

    const runId = task.runId;
    const courseTabOpen = isCourseTabAlive();
    touchTabPresence(false, true);
    task.stage = 'course';
    task.pending = null;
    task.waitingForCourseUrl = true;
    task.nextCourseRedirectUrl = '';
    task.courseRelayConsumedBy = '';
    task.expect = { page: 'course', cwID: '', lectureID: '', accountTag: task.accountTag || '' };
    if (!commitTask(task)) return;

    Log.info(
      '本课讲次全部完成（' +
        (cName || '当前课程') +
        '）：' +
        LectureAdapter.summarize(rows) +
        (courseTabOpen
          ? '。已通知「我的课程」标签页自动切换下一门课程…'
          : '。正在检查是否有已开启的「我的课程」标签页接力下一门课程…')
    );
    notice(
      'info',
      '本课程「' +
        (cName || '当前课程') +
        '」全部讲次已完成！正在由「我的课程」页面自动切换下一门课程…'
    );
    releaseLeaseForHandoff();

    const waitMs = courseTabOpen
      ? Math.max(CFG.courseRelayWaitMs || 5000, 12000)
      : (CFG.courseRelayWaitMs || 3500);

    StepTimers.setTimeout('waitCourseRelay', function () {
      const cur = Store.readTask();
      if (!cur || !cur.active || cur.runId !== runId) return;
      if (cur.nextCourseRedirectUrl) {
        const nextUrl = String(cur.nextCourseRedirectUrl).trim();
        cur.nextCourseRedirectUrl = '';
        cur.waitingForCourseUrl = false;
        cur.courseRelayConsumedBy = S.tabId;
        cur.courseRelayConsumedAt = Date.now();
        Store.writeTask(cur);
        Log.info('收到下一门课程讲次列表地址，正在同页跳转：' + nextUrl);
        navigateSameTab(nextUrl);
        return;
      }
      if (cur.stage !== 'course' || !cur.waitingForCourseUrl) return;
      cur.active = false;
      cur.stage = 'done';
      cur.waitingForCourseUrl = false;
      cur.finishedAt = Date.now();
      cur.result =
        '本课程「' +
        (cName || '当前课程') +
        '」全部讲次已完成！（未检测到开启中的「我的课程」列表标签页，已安全停在本页；如需多门课程自动连播，请保持「我的课程」标签页开启并在该页点“启动”）。';
      Store.writeTask(cur);
      S.task = cur;
      Log.info(cur.result);
      notice('info', cur.result);
      UI.update();
    }, waitMs);
  }

  /* ---------------------------------------------------------------------
   * 18.3 播放页：正常播放、ended 后进入核验、尊重手动暂停与验证弹窗
   * ------------------------------------------------------------------- */
  async function stepPlayer(task) {
    const video = await Utils.waitUntil(function () {
      return PlayerAdapter.video();
    }, CFG.videoWaitMs);
    if (!isExecutor()) return;
    if (!video) {
      if (Pages.loginSuspect()) {
        return fail('登录状态可能已失效，播放页没有出现视频。', '请重新登录后再点“启动”。');
      }
      return fail('播放页里没有找到视频元素（video）。', '页面结构可能已变化，或视频还没加载出来；可点“重试”。');
    }
    bindVideo(video);

    const params = PlayerAdapter.urlParams();
    const chk = expectCheck(task);
    if (!chk.ok) {
      // 本页不是任务目标的那个讲次/那个账号：不播放，只显示状态
      S.passive = true;
      notice('info', '本页不接手：' + chk.reason + '。任务仍在别处；如需在本页重新开始，请点“启动”。');
      enforceSilence();
      UI.update();
      return;
    }
    task.accountTag = task.accountTag || currentAccountTag();
    if (task.accountTag && !task.expect) {
      task.expect = { page: 'player', cwID: params.cwID || '', lectureID: params.lectureID || '', accountTag: task.accountTag };
      commitTask(task);
    }

    // 刷新发生在“ended 后等待核验”期间：补上剩余等待再回列表
    if (task.stage === 'confirm' && task.pending) {
        const endedAt = task.pending.endedAt || Date.now();
      const left = Utils.clamp(endedAt + CFG.initialVerifyWaitMs - Date.now(), 0, CFG.initialVerifyWaitMs);
      notice('info', '视频已结束，' + Math.round(left / 1000) + ' 秒后回讲次列表核验完成状态…');
      StepTimers.setTimeout('confirmNav', guard(navigateToLectureList), left);
      return;
    }

    if (S.userPaused) {
      notice('warn', '上次是手动暂停。点“继续播放”恢复（脚本不会自动续播）。');
      UI.update();
      return;
    }
    if (S.verifyBlocked) {
      notice('warn', '页面上有验证弹窗，请完成验证后点“继续播放”。');
      UI.update();
      return;
    }
    if (video.ended) {
      handleEnded();
      return;
    }
    ensurePlaying();
    StepTimers.setTimeout(
      'initPlayKick1',
      guard(function () {
        refreshBoundVideo();
        if (S.endedHandled || S.userPaused || S.verifyBlocked || !S.video) return;
        if (S.video.paused || PlayerAdapter.isUiPaused(S.video) || !isFinite(S.video.duration) || (S.video.currentTime || 0) < 0.2) {
          ensurePlaying(true);
        }
      }),
      800
    );
    StepTimers.setTimeout(
      'initPlayKick2',
      guard(function () {
        refreshBoundVideo();
        if (S.endedHandled || S.userPaused || S.verifyBlocked || !S.video) return;
        if (S.video.paused || PlayerAdapter.isUiPaused(S.video) || !isFinite(S.video.duration) || (S.video.currentTime || 0) < 0.2) {
          ensurePlaying(true);
        }
      }),
      2200
    );
  }

  /**
   * 注入页面级防后台暂停与 Video.js 播放唤醒守卫（运行于主世界，v1.1.0）：
   * 1. 仅在视频已加载出有效时长（isFinite(duration) && duration > 0）且未接近末尾时拦截非用户 pause()，
   *    避免在播放器初始化阶段（duration=未知, currentTime=0s）误拦 Video.js 内部重置导致卡在暂停态；
   * 2. 提供 dah-vjs-play 事件桥，在主世界直接调用 Video.js player.play() 及点击大播放按钮，解决跨页进入播放页后停留暂停态问题。
   */
  function installPagePlayGuard() {
    if (document.getElementById('dah-bg-guard')) return;
    try {
      const s = document.createElement('script');
      s.id = 'dah-bg-guard';
      s.textContent = [
        '(function(){',
        '  if (window.__DAH_BG_GUARD__) return;',
        '  window.__DAH_BG_GUARD__ = true;',
        '  var winFocused = true, lastBlurAt = 0, lastUserActAt = 0;',
        '  function isNearEnd(v) {',
        '    if (!v) return false;',
        '    if (v.ended) return true;',
        '    var d = v.duration, c = v.currentTime;',
        '    if (typeof d === "number" && isFinite(d) && d > 30 && typeof c === "number" && isFinite(c)) {',
        '      if (c >= d - 2.5) return true;',
        '    }',
        '    return false;',
        '  }',
        '  function isReadyToGuardPause(v) {',
        '    if (!v) return false;',
        '    var d = v.duration, c = v.currentTime;',
        '    return typeof d === "number" && isFinite(d) && d > 0 && (!v.paused || (typeof c === "number" && c > 0.5));',
        '  }',
        '  document.addEventListener("dah-vjs-play", function(){',
        '    try {',
        '      if (typeof window.videojs === "function") {',
        '        var players = window.videojs.getPlayers ? window.videojs.getPlayers() : null;',
        '        var p = (players && (players.player_daPlayer || players[Object.keys(players)[0]])) || null;',
        '        if (p && typeof p.play === "function") {',
        '          var r = p.play();',
        '          if (r && typeof r.catch === "function") r.catch(function(){});',
        '        }',
        '      }',
        '      var v = document.querySelector("video#player_daPlayer_html5_api, video#player_daPlayer, video.vjs-tech, video");',
        '      var vjsWrap = document.querySelector("#player_daPlayer.video-js, .video-js");',
        '      var isPausedUi = (v && v.paused) || (vjsWrap && vjsWrap.classList && vjsWrap.classList.contains("vjs-paused"));',
        '      if (isPausedUi) {',
        '        var btn = document.querySelector(".video-js.vjs-paused .vjs-big-play-button, .vjs-big-play-button, .vjs-play-control.vjs-paused");',
        '        if (btn && typeof btn.click === "function") btn.click();',
        '      }',
        '    } catch (err) {}',
        '  });',
        '  window.addEventListener("blur", function(){',
        '    winFocused = false; lastBlurAt = Date.now();',
        '    try { document.documentElement.setAttribute("data-dah-unfocused", "1"); } catch (err) {}',
        '  }, true);',
        '  window.addEventListener("focus", function(){',
        '    winFocused = true;',
        '    try { document.documentElement.removeAttribute("data-dah-unfocused"); } catch (err) {}',
        '  }, true);',
        '  var onAct = function(e){',
        '    if (e && e.isTrusted === false && !window.__DAH_SYNTHETIC_USER_CLICK__) return;',
        '    if (e && e.target && e.target.closest && e.target.closest("#dah-panel")) return;',
        '    lastUserActAt = Date.now(); winFocused = true;',
        '    try { document.documentElement.removeAttribute("data-dah-unfocused"); } catch (err) {}',
        '  };',
        '  document.addEventListener("pointerdown", onAct, true);',
        '  document.addEventListener("mousedown", onAct, true);',
        '  document.addEventListener("touchstart", onAct, true);',
        '  document.addEventListener("keydown", function(e){',
        '    var k = e && (e.key || e.code) || "";',
        '    if (k === " " || k === "Space" || k === "k" || k === "K" || k === "Enter" || k === "MediaPlayPause") onAct(e);',
        '  }, true);',
        '  if (typeof Document !== "undefined" && Document.prototype && typeof Document.prototype.hasFocus === "function") {',
        '    var origHasFocus = Document.prototype.hasFocus;',
        '    Document.prototype.hasFocus = function(){',
        '      try {',
        '        if (this.querySelector && this.querySelector("video[data-dah-keep-playing=\"1\"]")) return true;',
        '      } catch (err) {}',
        '      return origHasFocus.apply(this, arguments);',
        '    };',
        '  }',
        '  if (typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype && HTMLMediaElement.prototype.pause) {',
        '    var origPause = HTMLMediaElement.prototype.pause;',
        '    HTMLMediaElement.prototype.pause = function(){',
        '      try {',
        '        if (!window.__DAH_ALLOW_HIDDEN_PAUSE_EVENT__ && this && this.getAttribute && this.getAttribute("data-dah-keep-playing") === "1" && isReadyToGuardPause(this) && !isNearEnd(this)) {',
        '          var now = Date.now();',
        '          var evType = (window.event && window.event.type) ? String(window.event.type) : "";',
        '          var inBlurEvent = /^(blur|focusout|pagehide|.*visibility.*)$/i.test(evType);',
        '          if (inBlurEvent) {',
        '            winFocused = false; lastBlurAt = now;',
        '            try { document.documentElement.setAttribute("data-dah-unfocused", "1"); } catch (err) {}',
        '          }',
        '          var recentUser = lastUserActAt > 0 && (now - lastUserActAt < 1200) && lastUserActAt >= lastBlurAt && !inBlurEvent;',
        '          if (!recentUser) {',
        '            return;',
        '          }',
        '        }',
        '      } catch (err) {}',
        '      return origPause.apply(this, arguments);',
        '    };',
        '  }',
        '})();'
      ].join('\n');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 动态检查并重绑当前 DOM 中实际生效的 video 元素（兼容 Video.js 初始化时替换原 video 节点导致旧节点脱离 DOM 假播、新节点暂停） */
  function refreshBoundVideo() {
    if (S.page !== 'player') return S.video;
    const cur = PlayerAdapter.video();
    if (cur && (cur !== S.video || !S.video || !S.video.isConnected)) {
      const hadPlayIntent = S.playIntent;
      bindVideo(cur);
      if (hadPlayIntent && canAct() && !S.endedHandled && !S.userPaused && !S.verifyBlocked) {
        StepTimers.setTimeout(
          'rebindPlay',
          guard(function () {
            if (!S.endedHandled && !S.userPaused && !S.verifyBlocked) ensurePlaying(true);
          }),
          50
        );
      }
    }
    return S.video;
  }

  /** 播放进度推进时同步刷新进度时间戳、租约及鼠标防挂机保活 */
  function handleTimeUpdate() {
    const video = S.video;
    if (!video || S.endedHandled) return;
    if (PlayerAdapter.nearVideoEnd(video)) {
      setKeepPlayingMark(false);
      if (video.ended) handleEnded();
      return;
    }
    const sec = Math.floor(video.currentTime || 0);
    if (sec !== S.lastProgressSec) {
      S.lastProgressSec = sec;
      S.lastProgressAt = Date.now();
      S.stallCount = 0;
    }
    if (S.executing && !S.handedOff) {
      if (S.playIntent && !video.paused && (video.currentTime || 0) > 0.5) {
        setKeepPlayingMark(true);
      }
      const now = Date.now();
      if (now - S.lastTimeUpdateRenewAt >= 4000) {
        S.lastTimeUpdateRenewAt = now;
        renewLease();
        PlayerAdapter.dismissIdlePrompt();
      }
      if (now - S.lastMouseKeepAliveAt >= (CFG.mouseKeepAliveMs || 25000)) {
        S.lastMouseKeepAliveAt = now;
        PlayerAdapter.simulateMouseActivity();
      }
    }
  }

  /** 最小化/后台或挂机弹窗期间被暂停后的阶梯式自动恢复播放 */
  function scheduleBgResume() {
    if (!canAct() || S.endedHandled || S.userPaused || S.verifyBlocked) return;
    refreshBoundVideo();
    if (PlayerAdapter.nearVideoEnd(S.video)) {
      handleEnded();
      return;
    }
    PlayerAdapter.dismissIdlePrompt(true);
    const now = Date.now();
    if (now - S.lastBgResumeAt > 5000) {
      S.bgResumeCount = 0;
    }
    S.lastBgResumeAt = now;
    S.bgResumeCount = (S.bgResumeCount || 0) + 1;
    if (S.bgResumeCount <= 4) {
      ensurePlaying(true);
    }
    const delays = CFG.bgResumeDelaysMs || [80, 350, 1200];
    const idx = Math.min(S.bgResumeCount - 1, delays.length - 1);
    const wait = delays[Math.max(0, idx)];
    StepTimers.setTimeout(
      'bgResume',
      guard(function () {
        refreshBoundVideo();
        if (S.endedHandled || !S.video) return;
        if (!S.video.paused && !PlayerAdapter.isUiPaused(S.video)) return;
        if (PlayerAdapter.nearVideoEnd(S.video)) {
          handleEnded();
          return;
        }
        PlayerAdapter.dismissIdlePrompt(true);
        if (S.userPaused || S.verifyBlocked) return;
        ensurePlaying(true);
      }),
      wait
    );
  }

  function bindVideo(video) {
    S.video = video;
    if (S.videoBoundTo === video) return;
    S.videoBoundTo = video;
    S.durationLogged = typeof video.duration === 'number' && isFinite(video.duration) && video.duration > 0;
    installPagePlayGuard();
    Listeners.add(video, 'ended', handleEnded);
    Listeners.add(video, 'pause', handlePause);
    Listeners.add(video, 'play', handlePlay);
    Listeners.add(video, 'timeupdate', handleTimeUpdate);
    Listeners.add(video, 'error', handleVideoError);
    const onMediaReady = function () {
      if (video !== S.video || S.endedHandled) return;
      if (typeof video.duration === 'number' && isFinite(video.duration) && video.duration > 0 && !S.durationLogged) {
        S.durationLogged = true;
        Log.info(
          '视频元数据已就绪：duration=' +
            Math.round(video.duration) +
            's，currentTime=' +
            Math.round(video.currentTime || 0) +
            's，paused=' +
            video.paused +
            '。'
        );
      }
      if (
        canAct() &&
        S.playIntent &&
        !S.userPaused &&
        !S.verifyBlocked &&
        (video.paused || PlayerAdapter.isUiPaused(video) || (video.currentTime || 0) < 0.2)
      ) {
        ensurePlaying(true);
      }
    };
    Listeners.add(video, 'loadedmetadata', onMediaReady);
    Listeners.add(video, 'canplay', onMediaReady);
    Listeners.add(video, 'durationchange', onMediaReady);
    S.lastProgressSec = Math.floor(video.currentTime || 0);
    S.lastProgressAt = Date.now();
    Log.info(
      '已绑定视频：duration=' + (isFinite(video.duration) ? Math.round(video.duration) + 's' : '未知') +
        '，currentTime=' + Math.round(video.currentTime || 0) + 's，paused=' + video.paused + '。'
    );
    if (Timers.names().indexOf('verifyPoll') < 0) Timers.every('verifyPoll', guard(checkVerification), CFG.verifyPollMs);
    if (Timers.names().indexOf('stallCheck') < 0) Timers.every('stallCheck', guard(checkStall), CFG.stallCheckMs);
  }

  function ensurePlaying(forceKick) {
    refreshBoundVideo();
    const video = S.video;
    if (!video || S.endedHandled) return;
    if (!canAct()) return;
    if (S.verifyBlocked || S.userPaused) return;
    if (PlayerAdapter.nearVideoEnd(video)) {
      setKeepPlayingMark(false);
      if (video.ended || video.paused) handleEnded();
      return;
    }
    PlayerAdapter.dismissIdlePrompt();
    const uiPaused = PlayerAdapter.isUiPaused(video);
    const stuckAtStart =
      !video.paused &&
      (!isFinite(video.duration) || (video.currentTime || 0) < 0.2) &&
      S.lastProgressAt > 0 &&
      Date.now() - S.lastProgressAt > 3000;
    if (!video.paused && !video.ended && !forceKick && !uiPaused && !stuckAtStart) {
      S.playIntent = true;
      S.playRequested = true;
      S.autoplayBlocked = false;
      setKeepPlayingMark(true);
      notice('info', '正在播放，等待本讲结束…');
      UI.update();
      return;
    }
    S.playIntent = true;
    S.playRequested = true;
    if (forceKick || uiPaused || stuckAtStart) {
      try {
        document.dispatchEvent(new CustomEvent('dah-vjs-play'));
      } catch (e) {}
    }
    let result;
    try {
      result = video.play();
    } catch (e) {
      handlePlayError(e);
      return;
    }
    if (result && typeof result.then === 'function') {
      result
        .then(function () {
          S.autoplayBlocked = false;
          S.playRetries = 0;
          setKeepPlayingMark(true);
          notice('info', '正在播放，等待本讲结束…');
          UI.update();
        })
        .catch(function (err) {
          handlePlayError(err);
        });
    } else {
      S.playRetries = 0;
      setKeepPlayingMark(true);
      notice('info', '正在播放，等待本讲结束…');
    }
  }

  function handlePlayError(err) {
    if (S.endedHandled || PlayerAdapter.nearVideoEnd(S.video)) {
      if (S.video && (S.video.ended || PlayerAdapter.nearVideoEnd(S.video))) handleEnded();
      return;
    }
    const name = (err && err.name) || '';
    const msg = (err && err.message) || name || '未知错误';
    if (name === 'NotAllowedError') {
      S.autoplayBlocked = true;
      notice('warn', '浏览器拦截了自动播放。请点本面板的“继续播放”（或页面上的播放按钮），任务会接着跑。');
      Log.warn('自动播放被浏览器拦截。');
      UI.update();
      return;
    }
    if (name === 'AbortError' || /interrupted by a call to pause|interrupted by a new load/i.test(msg)) {
      const dismissed = PlayerAdapter.dismissIdlePrompt(true);
      Log.info(
        '播放请求被站点暂停打断（' +
          (dismissed ? '已自动关闭挂机提示弹窗，' : '') +
          '正在自动恢复播放…）'
      );
      notice('info', '检测到站点暂停打断播放，正在自动关闭提示并恢复播放…', 'hidden-pause');
      StepTimers.setTimeout(
        'playRetry',
        guard(function () {
          if (S.endedHandled || PlayerAdapter.nearVideoEnd(S.video)) return;
          PlayerAdapter.dismissIdlePrompt(true);
          if (isExecutor() && !S.userPaused && !S.verifyBlocked) ensurePlaying(true);
        }),
        450
      );
      UI.update();
      return;
    }
    S.playRetries = (S.playRetries || 0) + 1;
    if (S.playRetries > CFG.playRetryBackoffMs.length) {
      return fail('视频无法播放（' + msg + '）。', '可手动点页面播放按钮；仍不行请检查网络后点“重试”。');
    }
    const wait = CFG.playRetryBackoffMs[S.playRetries - 1];
    notice('warn', '播放失败（' + msg + '），' + Math.round(wait / 1000) + ' 秒后重试（第 ' + S.playRetries + ' 次）。');
    Log.warn('播放失败：' + msg);
    StepTimers.setTimeout('playRetry', function () {
      if (isExecutor() && !S.endedHandled) ensurePlaying(true);
    }, wait);
  }

  function handleVideoError() {
    const video = S.video;
    const code = video && video.error ? video.error.code : 0;
    Log.warn('video error 事件，code=' + code);
    if (!S.executing) return;
    S.playRetries = (S.playRetries || 0) + 1;
    if (S.playRetries > CFG.playRetryBackoffMs.length) {
      return fail('视频加载失败（错误码 ' + code + '）。', '请检查网络，或稍后点“重试”。');
    }
    const wait = CFG.playRetryBackoffMs[S.playRetries - 1];
    notice('warn', '视频出错（错误码 ' + code + '），' + Math.round(wait / 1000) + ' 秒后重试（第 ' + S.playRetries + ' 次）。');
    StepTimers.setTimeout('playRetry', function () {
      if (isExecutor()) ensurePlaying();
    }, wait);
  }

  function handlePlay() {
    if (S.endedHandled) return;
    S.playRequested = true;
    enforceSilence();
    if (!isExecutor()) {
      UI.update();
      return;
    }
    S.userPaused = false;
    S.autoplayBlocked = false;
    S.playRetries = 0;
    S.pauseCause = '';
    S.lastScriptPause = null;
    S.expectPause = null;
    StepTimers.clear('bgResume');
    setKeepPlayingMark(true);
    const task = readTask();
    if (task && task.userPaused) {
      task.userPaused = false;
      writeTask(task);
    }
    syncPlayingNotice();
    UI.update();
  }

  /**
   * 暂停归因与后台/挂机弹窗自动续播（v1.1.0）：
   * - 当视频到达流末尾（video.ended 或 currentTime >= duration - 2.5s）触发 pause 时，
   *   直接交由 handleEnded() 处理，绝不调用 scheduleBgResume() 重新 play()！
   */
  function handlePause() {
    const video = S.video;
    if (!video || S.endedHandled) return;
    const at = Date.now();
    if (S.pauseEvents.length > 7) S.pauseEvents.shift();
    S.pauseEvents.push({ at, cause: S.pauseCause, paused: video.paused, vis: document.visibilityState });
    if (video.ended || PlayerAdapter.nearVideoEnd(video)) {
      setKeepPlayingMark(false);
      handleEnded();
      return;
    }
    const exp = S.expectPause;
    if (exp && exp.video === video) {
      S.expectPause = null;
      return;
    }
    if (!video.paused) {
      Log.info('忽略迟到的 pause 事件（此时视频仍在播放，不改暂停归因）。');
      return;
    }
    if (!S.playRequested) return;
    if (S.verifyBlocked) {
      S.pauseCause = 'verify';
      return;
    }
    if (!isExecutor()) return;
    const dismissedIdle = PlayerAdapter.dismissIdlePrompt(true);
    const evType = window.event && window.event.type ? String(window.event.type) : '';
    const inBlurEvent = /^(blur|focusout|pagehide|.*visibility.*)$/i.test(evType);
    if (inBlurEvent) {
      S.windowFocused = false;
      S.lastBlurAt = at;
    }
    const isHidden = document.visibilityState === 'hidden' || !!document.hidden;
    const domUnfocused =
      document.documentElement && document.documentElement.getAttribute('data-dah-unfocused') === '1';
    const recentUserGesture =
      S.lastUserGestureAt > 0 && at - S.lastUserGestureAt < 1200 && S.lastUserGestureAt >= S.lastBlurAt && !inBlurEvent;
    const isBlurredOrNoGesture =
      dismissedIdle ||
      isHidden ||
      inBlurEvent ||
      domUnfocused ||
      !S.windowFocused ||
      (S.lastBlurAt > 0 && at - S.lastBlurAt < 1500) ||
      !recentUserGesture;
    if (isBlurredOrNoGesture) {
      S.pauseCause = 'hidden-pause';
      S.userPaused = false;
      Log.info(
        dismissedIdle
          ? '检测到挂机提醒弹窗触发暂停，已自动点击“确定”并恢复播放…'
          : '检测到最小化/后台或站点自动暂停，正在自动恢复播放…'
      );
      notice(
        'info',
        dismissedIdle
          ? '已自动关闭“好久没有动”挂机提示并恢复播放…'
          : '检测到后台/最小化期间视频被暂停，正在自动恢复播放…',
        'hidden-pause'
      );
      scheduleBgResume();
      UI.update();
      return;
    }
    setKeepPlayingMark(false);
    S.userPaused = true;
    S.pauseCause = 'user';
    S.pauseAt = at;
    const task = readTask();
    if (task && task.active) {
      task.userPaused = true;
      writeTask(task);
    }
    Log.info('检测到播放被暂停（由前台用户操作触发，视为用户主动暂停），不自动续播。');
    notice('warn', '播放被暂停（看起来是你手动暂停的）。任务已挂起，不会自动续播；点“继续播放”恢复。');
    UI.update();
  }

  function handleEnded() {
    if (!isExecutor()) return;
    if (S.endedHandled) {
      Log.info('忽略重复的 ended 事件（同一讲次只处理一次）。');
      return;
    }
    const task = readTask();
    if (!task || !task.active) return;
    if (task.stage === 'confirm') {
      S.endedHandled = true;
      return;
    }
    S.endedHandled = true;
    S.playIntent = false;
    setKeepPlayingMark(false);
    StepTimers.clear('bgResume');
    StepTimers.clear('playRetry');
    StepTimers.clear('initPlayKick1');
    StepTimers.clear('initPlayKick2');
    const video = S.video;
    const params = PlayerAdapter.urlParams();
    task.stage = 'confirm';
    task.pending = {
      lectureKey: task.lectureKey || (params.lectureID ? 'L:' + params.lectureID : ''),
      lectureTitle: task.lectureTitle || '',
      endedAt: Date.now(),
      checks: 0,
      runId: task.runId,
      frontendTimeSec: video ? Math.round(video.currentTime || 0) : -1,
      frontendDurationSec: video && isFinite(video.duration) ? Math.round(video.duration) : -1
    };
    task.expect = {
      page: 'lecture',
      cwID: params.cwID || task.cwID || '',
      lectureID: '',
      courseName: task.courseName || '',
      accountTag: task.accountTag || currentAccountTag()
    };
    if (!commitTask(task)) return;
    Log.info(
      '视频 ended（前端 currentTime=' +
        (task.pending.frontendTimeSec) + 's / duration=' + (task.pending.frontendDurationSec) +
        's；仅作诊断，不作为完成依据）。'
    );
    notice(
      'info',
      '视频播放结束。等待网站保存进度（初始等待 ' + Math.round(CFG.initialVerifyWaitMs / 1000) +
        ' 秒；这只是可调等待，不是实测的保存周期），之后回讲次列表核验完成状态。'
    );
    UI.update();
    StepTimers.setTimeout('confirmNav', guard(navigateToLectureList), CFG.initialVerifyWaitMs);
  }

  /**
   * 回讲次列表核验：页面里没有返回入口，用“已实测的路由 + 当前地址里的动态参数”拼地址。
   * 不包含 jsessionid，不猜任何签名，也不携带除 cwID/accountId 之外的任何身份参数。
   */
  function navigateToLectureList() {
    if (!canAct()) return;
    if (S.verifyBlocked) {
      StepTimers.setTimeout('confirmNav', guard(navigateToLectureList), 5000);
      return;
    }
    const params = PlayerAdapter.urlParams();
    if (!params.cwID) {
      return fail('播放页地址里读不到 cwID，无法回到讲次列表核验完成状态。', '请手动返回讲次列表，然后点“重试”。');
    }
    let target;
    try {
      const u = new URL(location.href);
      target = new URL('/cwweb/lecture/lectureList', u.origin);
      target.searchParams.set('cwID', params.cwID);
      target.searchParams.set('platformCode', PLATFORM_CODE);
      if (params.accountId) target.searchParams.set('accountId', params.accountId);
    } catch (e) {
      return fail('无法解析当前播放页地址，回不到讲次列表。', '请手动返回讲次列表后点“重试”。');
    }
    notice('info', '正在返回讲次列表核验完成状态…');
    Log.info('回讲次列表核验：' + target.pathname + '?cwID=' + params.cwID + '（动态参数取自当前地址）。');
    navigateSameTab(target.toString());
  }

  /* ---------------------------------------------------------------------
   * 18.4 监控：验证弹窗、播放卡顿
   * ------------------------------------------------------------------- */
  function checkVerification() {
    if (!S.page || S.endedHandled) return;
    const task = readTask();
    if (!task || !task.active) return;
    if (S.page === 'player') refreshBoundVideo();
    if (S.page === 'player' && !PlayerAdapter.nearVideoEnd(S.video) && PlayerAdapter.dismissIdlePrompt()) {
      if (S.video && (S.video.paused || PlayerAdapter.isUiPaused(S.video)) && !S.video.ended && canAct() && !S.userPaused && !S.verifyBlocked) {
        ensurePlaying(true);
      }
      return;
    }
    const found = PlayerAdapter.verificationOverlay();
    if (found && !S.verifyBlocked) {
      S.verifyBlocked = true;
      scriptPause('verify');
      Log.warn('检测到验证弹窗：' + found.text);
      notice('error', '检测到验证弹窗，已暂停任务。请在页面上完成验证（不要关掉弹窗），然后点“继续播放”。脚本不会绕过验证。');
      UI.update();
    }
  }

  function checkStall() {
    refreshBoundVideo();
    const video = S.video;
    if (!isExecutor() || !video || !S.playIntent || S.endedHandled) return;
    if (video.ended || PlayerAdapter.nearVideoEnd(video)) {
      S.stallCount = 0;
      handleEnded();
      return;
    }
    PlayerAdapter.dismissIdlePrompt();
    if (video.paused || PlayerAdapter.isUiPaused(video)) {
      S.stallCount = 0;
      if (!S.userPaused && !S.verifyBlocked && !S.autoplayBlocked) {
        Log.info('巡检发现视频处于非人工暂停状态，正在自动恢复播放…');
        ensurePlaying(true);
      }
      return;
    }
    const sec = Math.floor(video.currentTime || 0);
    if (sec !== S.lastProgressSec) {
      S.lastProgressSec = sec;
      S.lastProgressAt = Date.now();
      S.stallCount = 0;
      return;
    }
    if (Date.now() - S.lastProgressAt < CFG.stallCheckMs * 1.5) return;
    S.stallCount += 1;
    if (S.stallCount === 1) {
      Log.warn('播放进度长时间不变，尝试重新唤起播放一次。');
      ensurePlaying(true);
    } else if (!TEST_OVERRIDE.stallCheckMs && S.stallCount === 2) {
      Log.warn('播放进度仍未推进，正在通过播放器主世界接口二次强制唤醒播放…');
      scriptPause('kick');
      S.expectPause = null;
      ensurePlaying(true);
    } else if (!TEST_OVERRIDE.stallCheckMs && S.stallCount === 3 && (!isFinite(video.duration) || (video.currentTime || 0) < 1) && !S.playerReloadedOnce) {
      S.playerReloadedOnce = true;
      S.stallCount = 0;
      Log.warn('视频元数据长时间未就绪（duration=未知），自动刷新播放页重新加载视频流…');
      reloadSameTab();
    } else {
      fail('视频播放似乎卡住了（进度长时间不变）。', '请检查网络，或手动点页面播放按钮；可点“重试”。');
    }
  }

  /* ======================================================================
   * 19. 启动装配
   * ==================================================================== */

  function watchVideoElement() {
    let tries = 0;
    const tick = function () {
      refreshBoundVideo();
      if (S.video) {
        enforceSilence();
      }
      tries += 1;
      if (tries * 600 > CFG.videoWaitMs * 2) return;
      Timers.setTimeout('videoWatch', tick, 600);
    };
    Timers.setTimeout('videoWatch', tick, 300);
  }

  function bindLifecycle() {
    touchTabPresence(false, true);
    if (S.page === 'course' || S.page === 'lecture') {
      installSameTabNavGuard();
    }
    Listeners.add(window, 'pagehide', function () {
      if (!S.navigatingInternal) touchTabPresence(true, true);
      else touchTabPresence(false, true);
      if (S.executing) releaseLease();
      StepTimers.clearAll();
    });
    Listeners.add(window, 'beforeunload', function () {
      if (!S.navigatingInternal) touchTabPresence(true, true);
      else touchTabPresence(false, true);
      if (S.executing) releaseLease();
    });
    Listeners.add(
      window,
      'blur',
      function () {
        const now = Date.now();
        S.windowFocused = false;
        S.lastBlurAt = now;
        const recentGesture = S.lastUserGestureAt > 0 && now - S.lastUserGestureAt < 1000;
        if (
          S.page === 'player' &&
          !S.endedHandled &&
          !PlayerAdapter.nearVideoEnd(S.video) &&
          S.userPaused &&
          S.pauseCause === 'user' &&
          now - (S.pauseAt || 0) < 400 &&
          !recentGesture
        ) {
          S.userPaused = false;
          S.pauseCause = 'hidden-pause';
          const task = readTask();
          if (task && task.userPaused) {
            task.userPaused = false;
            writeTask(task);
          }
          Log.info('识别到刚才的暂停由窗口失焦/最小化触发（非用户手动暂停），立即自动恢复播放…');
          notice('info', '检测到窗口失焦/最小化触发的暂停，正在自动恢复播放…', 'hidden-pause');
          scheduleBgResume();
          UI.update();
        }
      },
      true
    );
    Listeners.add(
      window,
      'focus',
      function () {
        S.windowFocused = true;
        if (S.page === 'player' && !S.endedHandled && !PlayerAdapter.nearVideoEnd(S.video)) {
          PlayerAdapter.dismissIdlePrompt();
        }
        if (
          S.page === 'player' &&
          canAct() &&
          S.playIntent &&
          !S.endedHandled &&
          !PlayerAdapter.nearVideoEnd(S.video) &&
          !S.userPaused &&
          !S.verifyBlocked &&
          !S.autoplayBlocked &&
          S.video &&
          (S.video.paused || PlayerAdapter.isUiPaused(S.video)) &&
          !S.video.ended
        ) {
          ensurePlaying(true);
        }
      },
      true
    );
    const onUserGesture = function (e) {
      if (Date.now() - S.lastIdleDismissAt < 300) return;
      if (e && e.isTrusted === false && !window.__DAH_SYNTHETIC_USER_CLICK__) return;
      if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('#dah-panel')) return;
      if (document.visibilityState === 'hidden' || document.hidden) return;
      S.lastUserGestureAt = Date.now();
      S.windowFocused = true;
    };
    Listeners.add(document, 'pointerdown', onUserGesture, true);
    Listeners.add(document, 'mousedown', onUserGesture, true);
    Listeners.add(document, 'touchstart', onUserGesture, true);
    Listeners.add(
      document,
      'keydown',
      function (e) {
        const k = (e && (e.key || e.code)) || '';
        if (k === ' ' || k === 'Space' || k === 'k' || k === 'K' || k === 'Enter' || k === 'MediaPlayPause') {
          onUserGesture(e);
        }
      },
      true
    );
  }

  function boot() {
    if (window.top !== window.self) return;
    if (S.booted) return;
    // 先确认确实是受支持的页面再认领引导：标签页可能是空白/中转文档先出现，
    // 那种情况下不要抢跑（否则真正的页面加载完就再也不会初始化了）。
    const page = Pages.detect();
    if (!page) return;
    S.page = page;
    S.booted = true;
    S.tabId = tabId();
    UI.mount();
    bindLifecycle();
    Timers.every('ui', function () {
      enforceSilence();
      UI.update();
    }, CFG.uiTickMs);
    Store.watch(onStoreChange);
    const cfg = PlayerAdapter.pageConfig();
    if (Object.keys(cfg).length) {
      Log.info('播放页自带配置（只读，语义未核实）：' + JSON.stringify(cfg));
    }
    Log.info('页面类型：' + S.page + '；标签 ' + S.tabId + '；版本 ' + VERSION + '。');
    if (S.page === 'player') watchVideoElement();
    resumeOrIdle();
    UI.update();
  }

  // 调试/测试用只读出口：不改变页面行为，也不暴露任何身份信息
  window.__DONGAO_HELPER__ = {
    version: VERSION,
    config: CFG,
    Core: Core,
    pages: Pages,
    adapters: { course: CourseAdapter, lecture: LectureAdapter, player: PlayerAdapter },
    state: function () {
      return {
        page: S.page,
        tabId: S.tabId,
        runId: S.runId,
        executing: S.executing,
        passive: S.passive,
        handedOff: S.handedOff,
        userPaused: S.userPaused,
        verifyBlocked: S.verifyBlocked,
        autoplayBlocked: S.autoplayBlocked,
        // D：暂停归因（诊断用；测试据此断言“没有把脚本暂停误判成用户暂停”）
        pauseCause: S.pauseCause,
        pauseAt: S.pauseAt,
        playRequested: S.playRequested,
        pauseEvents: S.pauseEvents.slice(-5),
        noticeSource: S.noticeSource,
        leaseRecovering: S.leaseRecovering,
        handoffId: S.handoffId,
        leaseState: leaseStatus().state,
        endedHandled: S.endedHandled,
        silenced: S.silencedReason,
        video: (function () {
          const dom = document.querySelector('video');
          return {
            bound: !!S.video,
            boundId: S.video ? String(S.video.id || '') : '',
            same: !!S.video && S.video === dom,
            connected: !!(S.video && S.video.isConnected),
            boundPaused: S.video ? S.video.paused : null,
            domPaused: dom ? dom.paused : null,
            domCount: Dom.qsa('video').length
          };
        })(),
        notice: S.notice,
        task: Store.readTask(),
        lease: Store.readLease()
      };
    },
    log: function () {
      return Log.dump();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  // 空白/中转文档先出现时，等真正页面就绪再尝试一次（boot 自身幂等）
  window.addEventListener('pageshow', boot);
})();