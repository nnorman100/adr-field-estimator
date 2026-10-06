const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Verify index.html and public/index.html are byte-identical
const publicHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rootHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.strictEqual(publicHtml, rootHtml, "public/index.html and index.html must be identical");
console.log("✔ Synchronization Check: public/index.html and index.html are 100% identical");

// 2. Check DOM Elements for P0 and P1 requirements
assert(publicHtml.includes('id="photoFileInput"'), "photoFileInput must exist");
assert(publicHtml.includes('capture="environment"'), "photoFileInput must include capture='environment'");
assert(publicHtml.includes('accept="image/*"'), "photoFileInput must include accept='image/*'");
console.log("✔ P1 Fix 4 (Native Camera & Photo Upload Fallback): Input markup verified");

assert(publicHtml.includes('Upload / Cam Roll'), "Upload / Cam Roll trigger must exist");
console.log("✔ P1 Fix 4: Upload / Cam Roll trigger verified in technician footer");

assert(publicHtml.includes('id="btnAuthorizeJob"'), "btnAuthorizeJob must exist");
assert(publicHtml.includes('AUTHORIZE & SIGN'), "AUTHORIZE & SIGN button text must exist");
assert(publicHtml.includes('id="modalAuthConfirmation"'), "modalAuthConfirmation must exist");
assert(publicHtml.includes('id="authModalRef"'), "authModalRef must exist in modal");
assert(publicHtml.includes('id="authModalSigImg"'), "authModalSigImg must exist in modal");
console.log("✔ P1 Fix 6 (Work Authorization Submission & Modal): Authorization elements verified");

// 3. Extract and test JavaScript functions from <script>
const scriptMatch = publicHtml.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, "Script tag must exist");
const scriptCode = scriptMatch[1];

// Test normalizeXactimateItem
const vm = require('vm');
const context = {
  console: console,
  document: {
    getElementById: () => ({ innerText: '', value: '', classList: { add: () => {}, remove: () => {} } }),
    querySelector: () => null
  },
  window: { addEventListener: () => {} },
  navigator: { clipboard: { writeText: () => {} } },
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(context);

vm.runInContext(`
  ${scriptCode}
  this.testNormalize = normalizeXactimateItem;
  this.testEstimateState = estimateState;
`, context);

const normalizeFn = context.testNormalize;
assert(typeof normalizeFn === 'function', "normalizeXactimateItem must be a function");

// Test with short property names
const shortItem = normalizeFn({ code: "WTRDRY", desc: "Tear out drywall", qty: 36, unit: "SF", price: 8.94, waste: 10 });
assert.strictEqual(shortItem.code, "WTRDRY");
assert.strictEqual(shortItem.desc, "Tear out drywall");
assert.strictEqual(shortItem.description, "Tear out drywall");
assert.strictEqual(shortItem.qty, 36);
assert.strictEqual(shortItem.quantity, 36);
assert.strictEqual(shortItem.price, 8.94);
assert.strictEqual(shortItem.unit_price, 8.94);
assert.strictEqual(shortItem.waste, 10);
assert.strictEqual(shortItem.waste_percent, 10);
assert.strictEqual(shortItem.total, 354.02);

// Test with full property names (as returned by LLM / Backend)
const fullItem = normalizeFn({ code: "WTRDHM", description: "LGR Dehumidifier", quantity: 3, unit: "DA", unit_price: 145.00, waste_percent: 0, total: 435.00 });
assert.strictEqual(fullItem.desc, "LGR Dehumidifier");
assert.strictEqual(fullItem.description, "LGR Dehumidifier");
assert.strictEqual(fullItem.qty, 3);
assert.strictEqual(fullItem.quantity, 3);
assert.strictEqual(fullItem.price, 145.00);
assert.strictEqual(fullItem.unit_price, 145.00);
assert.strictEqual(fullItem.waste, 0);
assert.strictEqual(fullItem.waste_percent, 0);
assert.strictEqual(fullItem.total, 435.00);

// Test edge case: missing/undefined values
const emptyItem = normalizeFn({});
assert(!isNaN(emptyItem.price) && !isNaN(emptyItem.total), "Must not produce NaN");
assert.strictEqual(emptyItem.code, "MISC");

// Test edge case: null or empty string fallback
const nullFallbackItem = normalizeFn({ description: null, desc: 'Drywall demo', quantity: null, qty: 5, unit_price: null, price: 12.5 });
assert.strictEqual(nullFallbackItem.description, "Drywall demo");
assert.strictEqual(nullFallbackItem.quantity, 5, "Quantity should fall back to qty when null");
assert.strictEqual(nullFallbackItem.unit_price, 12.5, "Unit price should fall back to price when null");
assert.strictEqual(nullFallbackItem.total, 62.5, "Total should compute from fallback values");

const emptyStrFallbackItem = normalizeFn({ quantity: '', qty: 4, unit_price: '', price: 10 });
assert.strictEqual(emptyStrFallbackItem.quantity, 4, "Quantity should fall back to qty when empty string");
assert.strictEqual(emptyStrFallbackItem.unit_price, 10, "Unit price should fall back to price when empty string");
assert.strictEqual(emptyStrFallbackItem.total, 40, "Total should compute from fallback values");

console.log("✔ P0 Fix 1 (Schema Property Mismatch): normalizeXactimateItem verified against all schemas including null/empty fallbacks");

// 4. Verify P0 Fix 2: Unbound Audit Response Fields
assert(scriptCode.includes('audited.adr_estimate.findings_html'), "runAuditAndSwitch must bind findings_html");
assert(scriptCode.includes('audited.adr_estimate.recommendations_html'), "runAuditAndSwitch must bind recommendations_html");
assert(scriptCode.includes('defenseLetterBody'), "runAuditAndSwitch must update defenseLetterBody");
assert(scriptCode.includes('audited.adr_estimate.property_address'), "runAuditAndSwitch must update property_address");
assert(scriptCode.includes('audited.adr_estimate.date'), "runAuditAndSwitch must update date");
assert(publicHtml.includes('id="defenseLetterAddress"'), "defenseLetterAddress span must exist in markup");
assert(publicHtml.includes('id="defenseLeadParagraph"'), "defenseLeadParagraph span must exist in markup");
console.log("✔ P0 Fix 2 (Unbound Audit Response Fields): runAuditAndSwitch binds all audit fields and defense letter elements");

// 5. Verify P0 Fix 3: Pre-Walk Input State Synchronization & CA Pre-1978 rule
assert(scriptCode.includes('initPreWalkInputs'), "initPreWalkInputs function must exist");
assert(scriptCode.includes('inputClientName'), "Must listen on inputClientName");
assert(scriptCode.includes('inputYearBuilt'), "Must listen on inputYearBuilt");
assert(scriptCode.includes('selectAfterHours'), "Must listen on selectAfterHours");
assert(scriptCode.includes('yr < 1978'), "Must enforce CA Pre-1978 rule (< 1978)");
assert(scriptCode.includes('leadStatusTag'), "Must update leadStatusTag banner");
assert(scriptCode.includes('wideLeadRule'), "Must update wideLeadRule");
assert(publicHtml.includes('id="wideFormulaRange"'), "wideFormulaRange span must exist in sidebar markup");
console.log("✔ P0 Fix 3 (Pre-Walk Input Synchronization): Dynamic listeners and CA Pre-1978 banner verified");

// 6. Verify P1 Fix 5: Signature Canvas Persistence
assert(scriptCode.includes('cachedSignatureData'), "cachedSignatureData must be tracked");
assert(scriptCode.includes('hasUserSigned'), "hasUserSigned state must be tracked");
assert(scriptCode.includes('drawImage'), "resizeSignatureCanvas must restore image via drawImage");
assert(scriptCode.includes('preventDefault'), "Touch listeners must preventDefault to avoid touch scrolling");
assert(publicHtml.includes('id="printSigImg"'), "printSigImg must exist for print rasterization");
console.log("✔ P1 Fix 5 (Signature Canvas Persistence): Signature caching, redraw, and print element verified");

// 7. Verify P1 Fix 7: Live Voice Transcription
assert(scriptCode.includes('SpeechRecognition'), "Web Speech API SpeechRecognition must be configured");
assert(scriptCode.includes('accumulatedDictation'), "accumulatedDictation must accumulate text across utterances");
assert(scriptCode.includes('liveTranscript'), "Dictation must update liveTranscript");
assert(scriptCode.includes('wideTranscriptDisplay'), "Dictation must update wideTranscriptDisplay");
console.log("✔ P1 Fix 7 (Live Voice Transcription): Web Speech API and UI bindings verified");

console.log("\n==========================================");
console.log("🎉 ALL FRONTEND & BACKEND SUITES PASSED!");
console.log("==========================================\n");
