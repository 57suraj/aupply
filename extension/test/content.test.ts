/**
 * Content-script tests on synthetic Easy Apply markup (no real LinkedIn HTML, invented data):
 * modal anchoring, label reading, radio questions, field collection, applying actions, the job
 * page's Save button never clicked, Follow unticked, the tracker count, the URL allowlist, and the
 * hidden-tab-safe sleep. Run: npm run test:extension
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";

type Mods = {
  dom: typeof import("../src/content/linkedin/dom");
  form: typeof import("../src/content/linkedin/form");
  job: typeof import("../src/content/linkedin/job");
  sleep: typeof import("../src/content/sleep");
  allow: typeof import("../src/shared/allowlist");
};
let m: Mods;
let jsdom: JSDOM;

/** A fresh page; elements are "visible" unless they or an ancestor carry the hidden attribute. */
function page(html: string, url = "https://www.linkedin.com/jobs/view/4100000001/", title = "Backend Engineer | Acme Widgets | LinkedIn") {
  jsdom.reconfigure({ url });
  const d = jsdom.window.document;
  d.title = title;
  d.body.innerHTML = html;
  return d;
}

before(async () => {
  jsdom = new JSDOM("<!doctype html><html><head><title></title></head><body></body></html>", { url: "https://www.linkedin.com/", pretendToBeVisual: true });
  const w = jsdom.window as unknown as Record<string, any>;
  w.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = Boolean(this.closest("[hidden]"));
    const s = hidden ? 0 : 1;
    return { width: 100 * s, height: 20 * s, left: 10, top: 10, x: 10, y: 10, right: 110, bottom: 30, toJSON() {} };
  };
  if (!w.PointerEvent) w.PointerEvent = class extends w.MouseEvent {};
  const g = globalThis as Record<string, any>;
  for (const k of ["window", "document", "location", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "CustomEvent"]) {
    Object.defineProperty(g, k, { value: k === "window" ? w : w[k], configurable: true, writable: true });
  }
  // A MessageChannel stand-in: a message is a macrotask (as in a page), and nothing stays open
  // after the tests (Node's own ports would keep the process alive).
  g.MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => void setImmediate(() => this.port1.onmessage?.({})) };
  };
  m = {
    dom: await import("../src/content/linkedin/dom"),
    form: await import("../src/content/linkedin/form"),
    job: await import("../src/content/linkedin/job"),
    sleep: await import("../src/content/sleep"),
    allow: await import("../src/shared/allowlist"),
  };
});
after(() => jsdom.window.close());

const MODAL = (inner: string, nav = "Next") => `
  <div class="job-page">
    <button aria-label="Save Backend Engineer at Acme Widgets" class="jobs-save-button">Save</button>
  </div>
  <div class="artdeco-modal">
    <h2>Apply to Acme Widgets</h2>
    <div class="progress">50%</div>
    <form>${inner}</form>
    <footer><button type="button">${nav}</button></footer>
  </div>`;

describe("the Easy Apply modal", () => {
  it("is anchored from its nav button (no role=dialog)", () => {
    page(MODAL(`<input id="a" type="text">`));
    const mod = m.dom.modal();
    assert.ok(mod);
    assert.match(mod!.textContent ?? "", /Apply to Acme Widgets/);
    assert.ok(mod!.querySelector("#a"));
  });

  it("reads a label only from a container with exactly one control", () => {
    page(MODAL(`
      <div class="pair"><label>First name</label><input id="first" type="text"><input id="city" type="text" aria-label="City"></div>
      <div><label for="phone">Mobile phone number</label><input id="phone" type="text"></div>`));
    const d = jsdom.window.document;
    assert.equal(m.dom.lab(d.getElementById("phone")!), "Mobile phone number");
    // The old walk read "First name" for the city field.
    assert.equal(m.dom.lab(d.getElementById("city")!), "City");
  });

  it("reads a radio group's question from its legend, else the container text without a trailing Yes No", () => {
    page(MODAL(`
      <fieldset><legend>Do you have a valid driver's license?</legend>
        <input type="radio" name="dl" id="dl1"><label for="dl1">Yes</label><input type="radio" name="dl" id="dl2"><label for="dl2">No</label></fieldset>
      <div class="q"><span>Are you comfortable working from the office?</span>
        <div><input type="radio" name="wfo" id="w1"><label for="w1">Yes</label></div><div><input type="radio" name="wfo" id="w2"><label for="w2">No</label></div></div>`));
    const d = jsdom.window.document;
    assert.equal(m.dom.qOf([d.getElementById("dl1")!, d.getElementById("dl2")!]), "Do you have a valid driver's license?");
    assert.equal(m.dom.qOf([d.getElementById("w1")!, d.getElementById("w2")!]), "Are you comfortable working from the office?");
  });

  it("collects only the fields that still need a value, as the server's descriptors", () => {
    page(MODAL(`
      <div><label for="email">Email address</label><input id="email" type="text" value="asha@example.com"></div>
      <div><label for="np">Notice period *</label><select id="np"><option value="">Select an option</option><option value="1">Immediate</option><option value="2">1 month</option></select></div>
      <div><label for="done">Gender</label><select id="done"><option value="">Select an option</option><option value="d" selected>Decline</option></select></div>
      <div><label for="yrs">How many years of experience do you have with Node.js?</label><input id="yrs" type="number" required></div>
      <div><label for="cty">City</label><input id="cty" type="text" role="combobox" maxlength="80"></div>
      <div><label for="why">Why do you want to join?</label><textarea id="why"></textarea></div>
      <p>Education</p>
      <select id="m1"><option value="">Month</option><option value="1">January</option></select>
      <select id="y1"><option value="">Year</option><option value="2019">2019</option></select>
      <div hidden><label for="gone">Hidden</label><input id="gone" type="text"></div>
      <div><input type="checkbox" id="pp"><label for="pp">I agree to the privacy policy</label></div>
      <fieldset><legend>Which of these do you use?</legend>
        <input type="checkbox" id="c1"><label for="c1">Docker</label><input type="checkbox" id="c2"><label for="c2">Kubernetes</label></fieldset>`));
    const { fields } = m.form.collectFields();
    const by = (label: string) => fields.find((f) => f.label === label);
    assert.ok(!fields.some((f) => f.label === "Email address"), "a filled input is left alone");
    assert.ok(!fields.some((f) => f.label === "Gender"), "a select on a real option is left alone");
    assert.ok(!fields.some((f) => f.label === "Hidden"), "hidden fields are not fields");
    assert.deepEqual({ k: by("Notice period")?.kind, r: by("Notice period")?.required, empty: by("Notice period")?.option_values_empty }, { k: "select", r: true, empty: [true, false, false] });
    assert.equal(by("How many years of experience do you have with Node.js?")?.kind, "number");
    assert.equal(by("How many years of experience do you have with Node.js?")?.required, true);
    assert.deepEqual({ k: by("City")?.kind, max: by("City")?.max_length }, { k: "typeahead", max: 80 });
    assert.equal(by("Why do you want to join?")?.kind, "textarea");
    const dates = fields.filter((f) => f.kind === "date_select");
    assert.deepEqual(dates.map((f) => f.date), [{ part: "month", index: 0, context: "education" }, { part: "year", index: 1, context: "education" }]);
    assert.equal(fields.find((f) => f.kind === "checkbox")?.label.includes("I agree to the privacy policy"), true);
    assert.deepEqual(fields.find((f) => f.kind === "checkbox_group")?.options, ["Docker", "Kubernetes"]);
  });

  it("applies actions with the native setter, firing input and change", () => {
    page(MODAL(`
      <div><label for="np">Notice period</label><select id="np"><option value="">Select an option</option><option value="a">Immediate</option><option value="b">1 month</option></select></div>
      <div><label for="yrs">Years of experience</label><input id="yrs" type="text"></div>
      <fieldset><legend>Relocate?</legend><input type="radio" name="r" id="r1"><label for="r1">Yes</label><input type="radio" name="r" id="r2"><label for="r2">No</label></fieldset>
      <div><input type="checkbox" id="pp"><label for="pp">I agree to the privacy policy</label></div>`));
    const c = m.form.collectFields();
    const fid = (label: string) => c.fields.find((f) => f.label.startsWith(label))!.fid;
    const d = jsdom.window.document;
    const seen: string[] = [];
    for (const id of ["np", "yrs"]) for (const t of ["input", "change"]) d.getElementById(id)!.addEventListener(t, () => seen.push(`${id}:${t}`));
    m.form.applyActions(c, [
      { fid: fid("Notice period"), do: "choose", index: 2 },
      { fid: fid("Years of experience"), do: "set", value: "2" },
      { fid: fid("Relocate?"), do: "choose", index: 1 },
      { fid: fid("I agree"), do: "tick" },
    ]);
    assert.equal((d.getElementById("np") as HTMLSelectElement).value, "b");
    assert.equal((d.getElementById("yrs") as HTMLInputElement).value, "2");
    assert.equal((d.getElementById("r2") as HTMLInputElement).checked, true);
    assert.equal((d.getElementById("pp") as HTMLInputElement).checked, true);
    assert.deepEqual(seen, ["np:input", "np:change", "yrs:input", "yrs:change"]);
  });

  it("treats LinkedIn's numeric text inputs as number fields, and finds the ones it refused (BUGS.md B4)", () => {
    page(MODAL(`
      <div><label for="single-line-text-form-component-x-123-numeric">Current ctc:</label><input id="single-line-text-form-component-x-123-numeric" type="text"></div>
      <div><label for="plain">City</label><input id="plain" type="text"></div>`));
    const { fields } = m.form.collectFields();
    assert.equal(fields.find((f) => f.label === "Current ctc:")?.kind, "number");
    assert.equal(fields.find((f) => f.label === "City")?.kind, "text");
    page(MODAL(`
      <div><label for="ctc">Expected CTC:</label><input id="ctc" type="text" value="10 LPA (1000000 INR per year)"><span>Invalid input</span></div>
      <div><label for="ok">Years</label><input id="ok" type="text" value="2"><span>Invalid input</span></div>`));
    const refused = m.form.refusedNumbers();
    assert.deepEqual(refused.fields.map((f) => [f.label, f.kind]), [["Expected CTC:", "number"]]);
  });

  it("reads the tracker's Applied count", () => {
    page(`<main><nav><a>Saved · 12</a><a>Applied · 1,234</a></nav></main>`, "https://www.linkedin.com/jobs-tracker/?stage=applied");
    assert.equal(m.dom.trackerCount(), 1234);
  });
});

describe("one job, start to finish", () => {
  it("fills, unticks Follow, submits, and never clicks the job page's Save", { timeout: 60_000 }, async () => {
    const d = page(`
      <div class="job-page">
        <button aria-label="Save Backend Engineer at Acme Widgets" class="jobs-save-button" id="jobsave">Save</button>
        <button aria-label="Easy Apply to Backend Engineer at Acme Widgets" id="easy">Easy Apply</button>
      </div>
      <div id="slot"></div>`);
    let jobSaveClicks = 0;
    d.getElementById("jobsave")!.addEventListener("click", () => jobSaveClicks++);
    const slot = d.getElementById("slot")!;
    const page1 = `<div class="m"><h2>Apply to Acme Widgets</h2><span>0%</span>
      <div><label for="np">Notice period</label><select id="np"><option value="">Select an option</option><option value="a">Immediate</option><option value="b">1 month</option></select></div>
      <button type="button" id="next">Next</button></div>`;
    const page2 = `<div class="m"><h2>Apply to Acme Widgets</h2><span>100%</span><p>Review your application</p>
      <div class="follow"><input type="checkbox" id="fol" checked><label>Follow Acme Widgets to stay up to date with their page.</label></div>
      <button type="button" id="submit">Submit application</button></div>`;
    d.getElementById("easy")!.addEventListener("click", () => {
      slot.innerHTML = page1;
      d.getElementById("next")!.addEventListener("click", () => {
        if (!(d.getElementById("np") as HTMLSelectElement).value) return; // a required field: the page does not move
        slot.innerHTML = page2;
        d.getElementById("submit")!.addEventListener("click", () => {
          if ((d.getElementById("fol") as HTMLInputElement).checked) throw new Error("submitted while still following");
          slot.innerHTML = `<div role="alert">Your application was sent to Acme Widgets!</div><button type="button">Done</button>`;
        });
      });
    });

    const asked: { fields: { label: string; kind: string }[] }[] = [];
    const bridge = {
      async answers(_p: unknown, _c: string, fields: { fid: string; label: string; kind: string }[]) {
        asked.push({ fields });
        const np = fields.find((f) => f.label === "Notice period");
        return { verdict: "fill" as const, actions: np ? [{ fid: np.fid, do: "choose" as const, index: 2 }] : [], ai_used: false };
      },
      trustedClick: async () => false,
      handoff: async () => undefined,
      progress: () => undefined,
    };
    const res = await m.job.applyJob({ job: { id: "4100000001", company: "Acme Widgets", title: "Backend Engineer" }, page_wait_ms: 6000, country: "India" }, bridge);
    assert.equal(res.r, "SENT", JSON.stringify(res));
    assert.equal(jobSaveClicks, 0, "the job page's Save bookmarks the job: never clicked");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].fields.map((f) => [f.label, f.kind]), [["Notice period", "select"]]);
    assert.equal(res.page?.company, "Acme Widgets");
  });
});

describe("the URL allowlist", () => {
  it("allows only the four LinkedIn shapes", () => {
    const ok = [
      "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Backend+Engineer&location=India&f_TPR=r3600&f_AL=true&sortBy=DD&start=0",
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4100000001",
      "https://www.linkedin.com/jobs/view/4100000001/",
      "https://www.linkedin.com/jobs-tracker/?stage=applied",
    ];
    const bad = [
      "https://www.linkedin.com/feed/",
      "https://evil.example.com/jobs/view/4100000001/",
      "http://www.linkedin.com/jobs/view/4100000001/",
      "https://www.linkedin.com/jobs/view/4100000001/apply",
      "https://www.linkedin.com.evil.example/jobs/view/4100000001/",
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/abc",
    ];
    for (const u of ok) assert.equal(m.allow.allowed(u), true, u);
    for (const u of bad) assert.equal(m.allow.allowed(u), false, u);
    assert.equal(m.allow.jobIdOf("https://www.linkedin.com/jobs/view/4100000001/?trk=x"), "4100000001");
    assert.equal(m.allow.jobIdOf("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4100000001"), "4100000001");
  });
});

describe("sleep and until", () => {
  it("sleep is never shorter than asked", async () => {
    const t = Date.now();
    await m.sleep.sleep(120);
    assert.ok(Date.now() - t >= 115, `${Date.now() - t}ms`);
  });
  it("until returns as soon as the condition holds, and gives up after its time", async () => {
    let n = 0;
    const t = Date.now();
    assert.equal(await m.sleep.until(() => ++n >= 2 && "yes", 5000), "yes");
    assert.ok(Date.now() - t < 1500);
    const t2 = Date.now();
    assert.equal(await m.sleep.until(() => false, 700), false);
    assert.ok(Date.now() - t2 >= 690);
  });
});
