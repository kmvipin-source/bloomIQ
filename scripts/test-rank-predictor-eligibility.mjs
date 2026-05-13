// scripts/test-rank-predictor-eligibility.mjs
// Smoke tests for lib/rankPredictorEligibility — pins down the foolproof
// fix Vipin asked for on 2026-05-13 (Java quiz must not produce a CAT rank).
// Run as: node --experimental-strip-types scripts/test-rank-predictor-eligibility.mjs

import {
  classifyQuizForRankPrediction,
  validateExamType,
  validateScorePair,
  isRankExamType,
} from "../lib/rankPredictorEligibility.ts";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    process.stdout.write("  PASS " + name + "\n");
  } else {
    fail += 1;
    failures.push({ name: name, detail: detail || "" });
    process.stdout.write("  FAIL " + name + (detail ? " - " + detail : "") + "\n");
  }
}

console.log("\nclassifyQuizForRankPrediction - corporate skills REFUSE\n");
const corpCases = [
  { topic: "Java", expectedToken: "JAVA" },
  { topic: "Java Streams API", expectedToken: "JAVA" },
  { topic: "Python data structures", expectedToken: "PYTHON" },
  { name: "AWS Solutions Architect mock", expectedToken: "AWS" },
  { topicFamily: "Kubernetes basics", expectedToken: "KUBERNETES" },
  { topic: "Docker containers", expectedToken: "DOCKER" },
  { topic: "PostgreSQL indexes", expectedToken: "POSTGRESQL" },
  { topic: "React hooks", expectedToken: "REACT" },
];
for (const c of corpCases) {
  const v = classifyQuizForRankPrediction({
    topic: c.topic || null,
    name: c.name || null,
    topicFamily: c.topicFamily || null,
  });
  check(
    "corporate_skill for " + JSON.stringify(c),
    v.verdict === "corporate_skill" && v.matchedToken === c.expectedToken,
    "got verdict=" + v.verdict + ", matched=" + (v.matchedToken || "-")
  );
}

console.log("\nclassifyQuizForRankPrediction - known exams MAP\n");
const examCases = [
  { topic: "CAT Mock 1", expectedExam: "CAT" },
  { topic: "JEE Physics revision", expectedExam: "JEE_MAIN" },
  { name: "NEET Biology Test", expectedExam: "NEET" },
  { topic: "IIT JEE", expectedExam: "JEE_MAIN" },
  { topic: "IIM CAT prep", expectedExam: "CAT" },
  { topic: "AIIMS Biology", expectedExam: "NEET" },
];
for (const c of examCases) {
  const v = classifyQuizForRankPrediction({
    topic: c.topic || null,
    name: c.name || null,
    topicFamily: null,
  });
  check(
    "matches_known_exam=" + c.expectedExam + " for " + JSON.stringify(c),
    v.verdict === "matches_known_exam" && v.suggestedExamType === c.expectedExam,
    "got verdict=" + v.verdict + ", suggested=" + (v.suggestedExamType || "-")
  );
}

console.log("\nclassifyQuizForRankPrediction - other comp exams not refused\n");
for (const t of ["GMAT", "GATE", "UPSC", "IELTS", "BITSAT"]) {
  const v = classifyQuizForRankPrediction({ topic: t, name: null, topicFamily: null });
  check(
    "competitive_exam_other for " + t,
    v.verdict === "competitive_exam_other" && v.matchedToken === t,
    "got verdict=" + v.verdict
  );
}

console.log("\nclassifyQuizForRankPrediction - generic passes\n");
for (const t of ["Photosynthesis", "Algebra", "World History", "Climate change", null]) {
  const v = classifyQuizForRankPrediction({ topic: t, name: null, topicFamily: null });
  check("generic for " + JSON.stringify(t), v.verdict === "generic", "got verdict=" + v.verdict);
}

console.log("\nToken boundaries\n");
const safeCases = [
  { topic: "Javelin throw", shouldNotBe: "corporate_skill" },
  { topic: "Catalysis", shouldNotBe: "matches_known_exam" },
  { topic: "Catalogue of mistakes", shouldNotBe: "matches_known_exam" },
  { topic: "Catabolism", shouldNotBe: "matches_known_exam" },
];
for (const c of safeCases) {
  const v = classifyQuizForRankPrediction({ topic: c.topic, name: null, topicFamily: null });
  check("safe-tokenisation: " + c.topic + " != " + c.shouldNotBe, v.verdict !== c.shouldNotBe, "got verdict=" + v.verdict);
}

console.log("\nvalidateExamType\n");
const okPairs = [["JEE_MAIN","JEE_MAIN"],["NEET","NEET"],["CAT","CAT"],["CUSTOM","CUSTOM"],["custom","CUSTOM"],["","CUSTOM"],[null,"CUSTOM"],[undefined,"CUSTOM"]];
for (const pair of okPairs) {
  const v = validateExamType(pair[0]);
  check("validateExamType(" + JSON.stringify(pair[0]) + ")=" + pair[1], v.ok && v.value === pair[1]);
}
for (const b of ["JEE", "java", "rank", "0", 0, {}, true]) {
  const v = validateExamType(b);
  check("validateExamType(" + JSON.stringify(b) + ") rejects", !v.ok);
}

console.log("\nvalidateScorePair\n");
check("ok 80/100", validateScorePair(80,100).ok);
check("ok 0/10", validateScorePair(0,10).ok);
check("reject NaN", !validateScorePair(NaN,100).ok);
check("reject Infinity", !validateScorePair(Infinity,100).ok);
check("reject max=0", !validateScorePair(5,0).ok);
check("reject max<0", !validateScorePair(5,-1).ok);
check("reject raw<0", !validateScorePair(-1,10).ok);
check("reject raw>max", !validateScorePair(11,10).ok);
check("reject string raw", !validateScorePair("nope",10).ok);

console.log("\nisRankExamType\n");
check("isRankExamType('CAT') true", isRankExamType("CAT") === true);
check("isRankExamType('FOO') false", isRankExamType("FOO") === false);
check("isRankExamType(null) false", isRankExamType(null) === false);

console.log("\nDone: " + pass + " passed, " + fail + " failed.");
if (fail > 0) {
  console.error("\nFAILED TESTS:");
  for (const f of failures) {
    console.error(" - " + f.name + (f.detail ? " - " + f.detail : ""));
  }
  process.exit(1);
}
process.exit(0);
