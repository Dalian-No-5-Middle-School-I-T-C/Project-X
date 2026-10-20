/* Generated from src/shared/scoreProgress.ts — do not edit.
   Regenerate: npx tsx scripts/sync-score-progress-browser.ts */
"use strict";
var ScoreProgress = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/shared/scoreProgress.ts
  var scoreProgress_exports = {};
  __export(scoreProgress_exports, {
    NOTABLE_PROGRESS_RATE_PP: () => NOTABLE_PROGRESS_RATE_PP,
    PROGRESS_RATE_THRESHOLD_PP: () => PROGRESS_RATE_THRESHOLD_PP,
    examPairInTrend: () => examPairInTrend,
    hasResolvableFullScore: () => hasResolvableFullScore,
    judgeProgress: () => judgeProgress,
    meanScoreRate: () => meanScoreRate,
    scoreRateChange: () => scoreRateChange,
    scoreRateOf: () => scoreRateOf
  });
  var PROGRESS_RATE_THRESHOLD_PP = 3;
  var NOTABLE_PROGRESS_RATE_PP = 10;
  function round1(value) {
    return Math.round(value * 10) / 10;
  }
  function hasResolvableFullScore(fullScore) {
    return typeof fullScore === "number" && Number.isFinite(fullScore) && fullScore > 0;
  }
  function scoreRateOf(score, fullScore) {
    if (!hasResolvableFullScore(fullScore)) return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    return round1(score / fullScore * 100);
  }
  function meanScoreRate(rates) {
    if (rates.length === 0) return null;
    if (rates.some((rate) => typeof rate !== "number" || !Number.isFinite(rate))) return null;
    return round1(rates.reduce((sum, rate) => sum + rate, 0) / rates.length);
  }
  function scoreRateChange(current, previous) {
    if (typeof current !== "number" || !Number.isFinite(current)) return null;
    if (typeof previous !== "number" || !Number.isFinite(previous)) return null;
    return round1(current - previous);
  }
  function judgeProgress(changePP, thresholdPP = PROGRESS_RATE_THRESHOLD_PP) {
    if (typeof changePP !== "number" || !Number.isFinite(changePP)) return "unknown";
    if (changePP >= thresholdPP) return "up";
    if (changePP <= -thresholdPP) return "down";
    return "stable";
  }
  function examPairInTrend(trend, examId) {
    const index = trend.findIndex((point) => Number(point.examId) === examId);
    if (index < 0) return null;
    return { current: trend[index], previous: index > 0 ? trend[index - 1] : null };
  }
  return __toCommonJS(scoreProgress_exports);
})();
