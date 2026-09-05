/**
 * Tests for the facilitator support check.
 *
 * This guard exists because of a real failure: quoting a semantically-correct but
 * differently-spelled CAIP-2 id makes every paid route 500 with
 * `missing_facilitator`, while every unpaid surface of the service reports healthy.
 * The tests below pin the behaviour that makes that diagnosable — in particular
 * that the comparison is verbatim, since a normalizing comparison would pass on
 * exactly the input that breaks at request time.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertFacilitatorSupport } from "../src/facilitator.js";

const FULL = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TRUNCATED = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";

const realFetch = globalThis.fetch;

function stubFetch(body, { contentType = "application/json", status = 200 } = {}) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("assertFacilitatorSupport", () => {
  it("passes when the facilitator advertises the exact scheme and network", async () => {
    stubFetch({ kinds: [{ x402Version: 2, scheme: "exact", network: FULL }] });
    const result = await assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL });
    assert.deepEqual(result, { ok: true, kinds: 1 });
  });

  it("fails on a spelling near-miss and says which spelling to use", async () => {
    stubFetch({ kinds: [{ scheme: "exact", network: FULL }] });
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: TRUNCATED }),
      (err) => {
        assert.match(err.message, /same chain spelled differently/);
        assert.match(err.message, /ALGORAND_\*_GENESIS_HASH/);
        assert.match(err.message, /exact string/);
        return true;
      },
    );
  });

  it("fails when the scheme is absent even though the network is present", async () => {
    stubFetch({ kinds: [{ scheme: "upto", network: FULL }] });
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL }),
      /does not advertise scheme "exact"/,
    );
  });

  it("lists the Algorand networks it does support when there is no near-miss", async () => {
    stubFetch({ kinds: [{ scheme: "exact", network: "algorand:SomeOtherGenesisHash=" }] });
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL }),
      /Algorand networks it does advertise: algorand:SomeOtherGenesisHash=/,
    );
  });

  it("treats an HTML response as the wrong host rather than a parse error", async () => {
    // A dashboard SPA served on the API path is a real shape of this mistake, and
    // "unexpected token <" sends you debugging JSON instead of the URL.
    stubFetch("<!DOCTYPE html>", { contentType: "text/html" });
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL }),
      /not JSON — wrong host\?/,
    );
  });

  it("reports an unreachable facilitator as unreachable", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL }),
      /cannot reach facilitator at https:\/\/f.example\/supported/,
    );
  });

  it("handles a response with no kinds at all", async () => {
    stubFetch({});
    await assert.rejects(
      () => assertFacilitatorSupport({ facilitatorUrl: "https://f.example", caip2: FULL }),
      /Algorand networks it does advertise: none/,
    );
  });
});
