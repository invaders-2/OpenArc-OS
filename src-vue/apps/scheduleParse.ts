/**
 * 日历 · 本地规则日程解析（不调用模型）。
 *
 * 为什么是本地规则：当前没有「模型生成日程」的真实命令通道（task/agent 桥没有日历写入命令），
 * 与其伪造一个 AI 入口，不如把可解释的本地解析做实：
 *   · 解析出日期 / 时间 / 提醒 / 标题，并把「没识别到的部分」逐条告诉用户；
 *   · 结果只是预览草稿，必须由用户确认后才写入本机日程；
 *   · 不猜测未写明的字段：没写日期就用当前选中日期（会明确提示），没写时间就按全天。
 */

export type ParsedSchedule = {
  date: string;
  time: string;
  title: string;
  reminderMinutes: number | null;
  notes: string[];
  matched: { date: boolean; time: boolean; reminder: boolean };
};

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const NUM_TOKEN = "[0-9零〇一二两三四五六七八九十]{1,3}";

export function cnNumber(raw: string): number | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  if (text.startsWith("十")) {
    const rest = text.slice(1);
    const ones = rest ? CN_DIGITS[rest] : 0;
    return ones == null ? null : 10 + ones;
  }
  if (text.includes("十")) {
    const [head, tail] = text.split("十");
    const tens = CN_DIGITS[head];
    const ones = tail ? CN_DIGITS[tail] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  return CN_DIGITS[text] ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (date: Date) => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());

function validYmd(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return ymd(probe);
}

const WEEKDAY_INDEX: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
};

export function parseSchedule(rawText: string, fallbackDate: string, base: Date = new Date()): ParsedSchedule {
  const notes: string[] = [];
  let text = String(rawText || "").trim();
  let date = "";
  let time = "";
  let reminderMinutes: number | null = 10;
  const matched = { date: false, time: false, reminder: false };

  /* ── 日期 ─────────────────────────────────────────────────────────── */
  let hit = text.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/);
  if (hit) {
    const normalized = validYmd(Number(hit[1]), Number(hit[2]), Number(hit[3]));
    if (normalized) {
      date = normalized;
      matched.date = true;
      text = text.replace(hit[0], " ");
    } else {
      notes.push("识别到日期「" + hit[0] + "」但不合法，已忽略。");
    }
  }
  if (!date) {
    hit = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
    if (hit) {
      const month = Number(hit[1]);
      const day = Number(hit[2]);
      let year = base.getFullYear();
      let normalized = validYmd(year, month, day);
      if (normalized && normalized < fallbackDate) {
        const nextYear = validYmd(year + 1, month, day);
        if (nextYear) {
          year += 1;
          normalized = nextYear;
          notes.push("「" + hit[0] + "」今年已过，按明年 " + year + " 年解析。");
        }
      }
      if (normalized) {
        date = normalized;
        matched.date = true;
        text = text.replace(hit[0], " ");
      } else {
        notes.push("识别到日期「" + hit[0] + "」但不合法，已忽略。");
      }
    }
  }
  if (!date) {
    const relative = text.match(/大后天|后天|明天|明日|今天|今日/);
    if (relative) {
      const offset = relative[0] === "大后天" ? 3 : relative[0] === "后天" ? 2 : /明/.test(relative[0]) ? 1 : 0;
      const target = new Date(base);
      target.setDate(target.getDate() + offset);
      date = ymd(target);
      matched.date = true;
      text = text.replace(relative[0], " ");
    }
  }
  if (!date) {
    hit = text.match(/(下一?个?)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
    if (hit) {
      const nextWeek = !!hit[1];
      const targetIndex = WEEKDAY_INDEX[hit[2]];
      if (targetIndex != null) {
        const todayIndex = base.getDay() === 0 ? 7 : base.getDay();
        let delta = targetIndex - todayIndex;
        if (nextWeek) delta += 7;
        else if (delta < 0) delta += 7;
        const target = new Date(base);
        target.setDate(target.getDate() + delta);
        date = ymd(target);
        matched.date = true;
        text = text.replace(hit[0], " ");
      }
    }
  }
  if (!date) {
    date = fallbackDate;
    notes.push("没有识别到日期，使用当前选中的 " + fallbackDate + "；可在预览里改。");
  }

  /* ── 时间 ─────────────────────────────────────────────────────────── */
  hit = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (hit) {
    const hour = Number(hit[1]);
    const minute = Number(hit[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      time = pad(hour) + ":" + pad(minute);
      matched.time = true;
      text = text.replace(hit[0], " ");
    } else {
      notes.push("识别到时间「" + hit[0] + "」但不合法，已忽略。");
    }
  }
  if (!time) {
    hit = text.match(new RegExp("(上午|早上|早晨|早|中午|下午|傍晚|晚上|夜里|夜间|凌晨)?\\s*(" + NUM_TOKEN + ")\\s*[点时時]\\s*(半|" + NUM_TOKEN + "\\s*分?)?"));
    if (hit) {
      const period = hit[1] || "";
      const hourNumber = cnNumber(hit[2]);
      const minuteRaw = hit[3] || "";
      if (hourNumber != null && hourNumber >= 0 && hourNumber <= 24) {
        let hour = hourNumber === 24 ? 0 : hourNumber;
        if (/下午|傍晚|晚上|夜里|夜间|中午/.test(period) && hour < 12) hour += 12;
        if (/凌晨/.test(period) && hour === 12) hour = 0;
        const minute = minuteRaw === "半" ? 30 : minuteRaw ? cnNumber(minuteRaw.replace(/分/g, "")) ?? 0 : 0;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          time = pad(hour) + ":" + pad(minute);
          matched.time = true;
          if (!period) notes.push("没写明上午 / 下午，按 " + time + " 解析；可在预览里改。");
          text = text.replace(hit[0], " ");
        }
      }
    }
  }
  if (!time) {
    hit = text.match(/中午|正午/);
    if (hit) {
      time = "12:00";
      matched.time = true;
      text = text.replace(hit[0], " ");
      notes.push("只写了「中午」，按 12:00 解析。");
    }
  }
  if (!time) {
    notes.push("没有识别到具体时间，按全天日程处理；全天日程不设提醒。");
    reminderMinutes = null;
  }

  /* ── 提醒 ─────────────────────────────────────────────────────────── */
  hit = text.match(new RegExp("提前\\s*(" + NUM_TOKEN + "|半)\\s*(分钟|分|个小时|小时|钟头)"));
  if (hit) {
    const amount = hit[1] === "半" ? 0.5 : cnNumber(hit[1]);
    if (amount != null) {
      const unit = /小时|钟头/.test(hit[2]) ? 60 : 1;
      reminderMinutes = Math.max(0, Math.round(amount * unit));
      matched.reminder = true;
      text = text.replace(hit[0], " ");
    }
  } else if (/不用提醒|不提醒|无需提醒/.test(text)) {
    reminderMinutes = null;
    matched.reminder = true;
    text = text.replace(/不用提醒|不提醒|无需提醒/g, " ");
  } else if (/到点提醒|准时提醒/.test(text)) {
    reminderMinutes = 0;
    matched.reminder = true;
    text = text.replace(/到点提醒|准时提醒/g, " ");
  }
  if (matched.time && !matched.reminder && reminderMinutes === 10) {
    notes.push("没有写明提醒，默认提前 10 分钟；可在预览里改。");
  }

  /* ── 标题 ─────────────────────────────────────────────────────────── */
  let title = text
    .replace(/^(帮我|请|麻烦|我想|我要|安排|创建|新建|添加|新增|建个|建一个|记一下)\s*/g, "")
    .replace(/提醒我|提醒/g, " ")
    .replace(/[，。,.；;、:：!！?？\s]+/g, " ")
    .trim();
  if (!title) {
    title = "未命名日程";
    notes.push("没有解析出标题，已填「未命名日程」；请在预览里改成真实标题。");
  }

  return { date, time, title, reminderMinutes, notes, matched };
}

export const REMINDER_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "不提醒" },
  { value: 0, label: "到点提醒" },
  { value: 5, label: "提前 5 分钟" },
  { value: 10, label: "提前 10 分钟" },
  { value: 30, label: "提前 30 分钟" },
  { value: 60, label: "提前 1 小时" },
];

export function reminderOptionLabel(minutes: number | null): string {
  const found = REMINDER_OPTIONS.find((item) => item.value === minutes);
  return found ? found.label : "提前 " + (minutes ?? 0) + " 分钟";
}
