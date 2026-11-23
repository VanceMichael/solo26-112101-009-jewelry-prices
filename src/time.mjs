// 时间、时区与金额工具：全部基于 Node 标准库（Intl 提供 IANA 时区支持）。

/**
 * 元金额四舍五入到分，返回整数分。仅对非负价格使用 half-up。
 * @param {number} yuan
 * @returns {number}
 */
export function roundFen(yuan) {
  return Math.round((yuan + Number.EPSILON) * 100);
}

/** 分转两位小数字符串，便于展示。 */
export function fenToYuan(fen) {
  return (fen / 100).toFixed(2);
}

/**
 * 求某一 UTC 时刻在指定 IANA 时区下的偏移（墙钟 - UTC，毫秒）。
 */
function zoneOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(new Date(epochMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  // Node 的 Intl 在午夜可能给出 hour="24"。
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - epochMs;
}

/**
 * 把某时区下的墙钟时间换算为 UTC 毫秒。对夏令时切换点做一次二次校正。
 */
export function zonedWallToUtc(parts, timeZone) {
  const guessed = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute ?? 0,
    0,
  );
  const first = guessed - zoneOffsetMs(guessed, timeZone);
  return guessed - zoneOffsetMs(first, timeZone);
}

const RANGE_PATTERN =
  /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*至\s*(次日\s*)?(\d{1,2}):(\d{2})/;

/**
 * 解析“2026-11-20 21:00 至次日 02:00”这类门店本地时段，按门店时区换算 UTC。
 * 夜场跨日由“次日”体现。
 * @returns {{startUtc:string,endUtc:string,raw:string}|null}
 */
export function parseLocalRange(text, timeZone) {
  const match = RANGE_PATTERN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, nextDay, eh, em] = match;
  const start = zonedWallToUtc(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
    },
    timeZone,
  );
  const endParts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d) + (nextDay ? 1 : 0),
    hour: Number(eh),
    minute: Number(em),
  };
  const end = zonedWallToUtc(endParts, timeZone);
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    raw: text.trim(),
  };
}

export function isWithin(isoStart, isoEnd, isoAt) {
  const t = Date.parse(isoAt);
  return Date.parse(isoStart) <= t && t < Date.parse(isoEnd);
}
