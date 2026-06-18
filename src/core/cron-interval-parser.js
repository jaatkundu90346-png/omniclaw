/**
 * Cron Interval Parser - Natural language interval parsing for Mavis-style scheduling.
 * Supports: 5m, 1h, 2d, 1h30m, and raw cron expressions.
 */

/**
 * Parse natural language interval to milliseconds or cron expression.
 * @param {string} input - Natural interval like "5m", "1h", "2d", "1h30m" or raw cron
 * @param {Object} options - Parsing options
 * @returns {Object} Parsed result with ms (milliseconds), cron (cron expression), or raw
 */
export function parseInterval(input, options = {}) {
  const { returnType = "auto" } = options;
  
  if (!input || typeof input !== "string") {
    return { error: "Invalid input", raw: input };
  }
  
  const trimmed = input.trim();
  
  // Check for raw cron expression (has 5 space-separated fields)
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(trimmed)) {
    return {
      type: "cron",
      cron: trimmed,
      raw: input,
      description: `Cron: ${trimmed}`
    };
  }
  
  // Natural interval pattern: number followed by unit (s/m/h/d)
  const match = trimmed.match(/^(\d+)([smhd])(?:(\d+)([smhd]))?$/i);
  
  if (!match) {
    return { error: `Invalid interval format: ${input}`, raw: input };
  }
  
  const [, num1, unit1, num2, unit2] = match;
  const values = { s: 1, m: 60, h: 3600, d: 86400 };
  
  const totalSeconds = (parseInt(num1, 10) * (values[unit1.toLowerCase()] || 0)) +
                       (num2 && unit2 ? parseInt(num2, 10) * (values[unit2.toLowerCase()] || 0) : 0);
  
  if (totalSeconds <= 0) {
    return { error: "Interval must be positive", raw: input };
  }
  
  // Calculate milliseconds
  const ms = totalSeconds * 1000;
  
  // Convert to appropriate cron expression
  let cron;
  const now = new Date();
  
  if (unit1.toLowerCase() === "s") {
    // Seconds: */N * * * * *
    cron = `*/${num1} * * * * *`;
  } else if (unit1.toLowerCase() === "m") {
    // Minutes: */N * * * * (or specific minute)
    cron = num2 ? `0 */${num1} * * *` : `*/${num1} * * * *`;
  } else if (unit1.toLowerCase() === "h") {
    // Hours: 0 */N * * * (or specific hour)
    if (num2) {
      cron = `0 */${num1} * * *`;
    } else {
      cron = `0 */${num1} * * *`;
    }
  } else if (unit1.toLowerCase() === "d") {
    // Days: 0 0 */N * * (or 0 0 * * *)
    cron = num1 === "1" ? "0 0 * * *" : `0 0 */${num1} * *`;
  }
  
  // Calculate next run time
  const nextRun = new Date(now.getTime() + ms);
  
  return {
    type: "interval",
    ms,
    seconds: totalSeconds,
    cron,
    raw: input,
    nextRun: nextRun.toISOString(),
    description: describeInterval(num1, unit1, num2, unit2),
    components: {
      num1: parseInt(num1, 10),
      unit1: unit1.toLowerCase(),
      num2: num2 ? parseInt(num2, 10) : null,
      unit2: num2 ? unit2.toLowerCase() : null
    }
  };
}

/**
 * Describe the interval in human-readable format.
 */
function describeInterval(num1, unit1, num2, unit2) {
  const names = { s: "second", m: "minute", h: "hour", d: "day" };
  const plural = (n, u) => n === 1 ? names[u] : `${names[u]}s`;
  
  const part1 = `${num1} ${plural(parseInt(num1, 10), unit1)}`;
  const part2 = num2 ? `${num2} ${plural(parseInt(num2, 10), unit2)}` : null;
  
  return part2 ? `${part1} ${part2}` : part1;
}

/**
 * Parse active hours configuration.
 * @param {string} activeHours - Format: "HH:MM-HH:MM" or "none"
 * @returns {Object} Active hours configuration
 */
export function parseActiveHours(activeHours) {
  if (!activeHours || activeHours === "none") {
    return { enabled: false };
  }
  
  const match = activeHours.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  
  if (!match) {
    return { error: `Invalid active hours format: ${activeHours}`, enabled: false };
  }
  
  const [, startH, startM, endH, endM] = match;
  const startMinutes = parseInt(startH, 10) * 60 + parseInt(startM, 10);
  const endMinutes = parseInt(endH, 10) * 60 + parseInt(endM, 10);
  
  return {
    enabled: true,
    startMinutes,
    endMinutes,
    startTime: `${startH}:${startM}`,
    endTime: `${endH}:${endM}`,
    description: `${startH}:${startM} - ${endH}:${endM}`
  };
}

/**
 * Check if current time is within active hours.
 * @param {Object} activeHoursConfig - Result from parseActiveHours
 * @param {Date} [now] - Current time (for testing)
 * @returns {boolean} True if within active hours
 */
export function isWithinActiveHours(activeHoursConfig, now = new Date()) {
  if (!activeHoursConfig.enabled) {
    return true;
  }
  
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= activeHoursConfig.startMinutes && 
         currentMinutes <= activeHoursConfig.endMinutes;
}

/**
 * Parse timezone string to offset.
 * @param {string} timezone - IANA timezone name (e.g., "Asia/Calcutta", "UTC")
 * @returns {Object} Timezone configuration
 */
export function parseTimezone(timezone) {
  if (!timezone) {
    return { offset: 0, name: "UTC", abbr: "UTC" };
  }
  
  // Common timezone mappings for quick lookup
  const commonTimezones = {
    "UTC": { offset: 0 },
    "Asia/Calcutta": { offset: 330 },
    "Asia/Kolkata": { offset: 330 },
    "America/New_York": { offset: -240 },
    "America/Los_Angeles": { offset: -420 },
    "Europe/London": { offset: 0 },
    "Europe/Berlin": { offset: 60 },
    "Asia/Tokyo": { offset: 540 },
    "Asia/Shanghai": { offset: 480 },
  };
  
  const common = commonTimezones[timezone];
  if (common) {
    return { ...common, name: timezone, abbr: timezone.split("/").pop() };
  }
  
  // Fallback: try to calculate from system
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short"
    });
    // This is a best-effort fallback
    return { offset: 0, name: timezone, abbr: timezone.split("/").pop() };
  } catch {
    return { offset: 0, name: timezone, abbr: timezone };
  }
}

/**
 * Calculate next run time based on interval.
 * @param {string} input - Interval string
 * @param {Object} options - Options including timezone
 * @returns {Date} Next run time
 */
export function getNextRunTime(input, options = {}) {
  const { timezone = "UTC" } = options;
  const parsed = parseInterval(input);
  
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  
  return new Date(Date.now() + parsed.ms);
}

/**
 * Format interval for display.
 * @param {string} input - Interval string
 * @returns {string} Human-readable description
 */
export function formatInterval(input) {
  const parsed = parseInterval(input);
  
  if (parsed.error) {
    return parsed.error;
  }
  
  if (parsed.type === "cron") {
    return `Cron: ${parsed.cron}`;
  }
  
  return parsed.description;
}

/**
 * Validate interval format.
 * @param {string} input - Interval to validate
 * @returns {Object} Validation result
 */
export function validateInterval(input) {
  const parsed = parseInterval(input);
  
  return {
    valid: !parsed.error,
    parsed,
    message: parsed.error || "Valid interval"
  };
}

// Convenience aliases
export const parseSchedule = parseInterval;
export const parseDuration = parseInterval;
export default parseInterval;