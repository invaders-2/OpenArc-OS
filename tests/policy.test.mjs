import { test } from "node:test";
import assert from "node:assert/strict";
import policy from "../electron/policy.cjs";
test("navigation accepts only web URLs without embedded credentials", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:secret@example.com",
    "invalid",
  ])
    assert.equal(policy.safeURL(url), null);
  assert.equal(policy.safeURL("https://example.com"), "https://example.com/");
});
test("native bounds clamp to host and reject nonfinite values", () => {
  assert.deepEqual(
    policy.safeBounds({ x: -1, y: 20, width: 2000, height: 3000 }, [1000, 700]),
    { x: 0, y: 20, width: 1000, height: 680 },
  );
  assert.equal(
    policy.safeBounds({ x: NaN, y: 0, width: 10, height: 10 }, [100, 100]),
    null,
  );
});
