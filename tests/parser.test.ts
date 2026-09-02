import assert from "node:assert/strict";
import test from "node:test";
import { parseHnThreadUrl } from "../src/hn-client.ts";
import { htmlToPlainText, parseJobPost, sanitizeHnHtml, truncateHtmlWords } from "../src/parser.ts";

test("canonicalizes valid Hacker News thread URLs", () => {
  assert.deepEqual(parseHnThreadUrl(" https://news.ycombinator.com/item?id=49522897&foo=bar "), {
    id: 49522897,
    url: "https://news.ycombinator.com/item?id=49522897",
  });
  assert.throws(() => parseHnThreadUrl("http://news.ycombinator.com/item?id=1"));
  assert.throws(() => parseHnThreadUrl("https://example.com/item?id=1"));
  assert.throws(() => parseHnThreadUrl("https://news.ycombinator.com/item?id=1&id=2"));
});

test("extracts the first block, location, body roles, and body technologies", () => {
  const parsed = parseJobPost(
    "Cardog | Toronto, Canada or REMOTE | Full-time https://cardog.app/careers" +
    "<p>We build vehicle data systems.</p>" +
    "<p>Hiring: VIN Decode Engineer, Data Platform Engineer, Infrastructure Engineer, Founding Engineer (dealer platform). TypeScript, Postgres, Cloudflare Workers.</p>",
  );
  assert.equal(
    parsed.titleText,
    "Cardog | Toronto, Canada or REMOTE | Full-time https://cardog.app/careers",
  );
  assert.equal(parsed.company, "Cardog");
  assert.equal(parsed.locationText, "Toronto, Canada or REMOTE");
  assert.deepEqual(parsed.roles, [
    "VIN Decode Engineer",
    "Data Platform Engineer",
    "Infrastructure Engineer",
    "Founding Engineer (dealer platform)",
  ]);
  assert.deepEqual(parsed.technologies, ["TypeScript", "Postgres", "Cloudflare Workers"]);
  assert.match(parsed.contentHtml, /^<p>We build/);
});

test("extracts roles and onsite location from pipe-separated title", () => {
  const parsed = parseJobPost(
    "LatchBio | Member of Technical Staff (infra, ML infra, systems, platform, full stack) | ONSITE San Francisco | Full Time<p>Our mission is biology.</p>",
  );
  assert.equal(parsed.company, "LatchBio");
  assert.equal(parsed.locationText, "ONSITE San Francisco");
  assert.deepEqual(parsed.roles, [
    "Member of Technical Staff (infra, ML infra, systems, platform, full stack)",
  ]);
});

test("combines adjacent location and work-arrangement segments", () => {
  const parsed = parseJobPost(
    "Mondrio | Founding Product Engineer | San Francisco | ONSITE | $200k – $250k<p>Body</p>",
  );
  assert.equal(parsed.locationText, "San Francisco | ONSITE");
});

test("sanitizes executable HTML and hardens links", () => {
  const safe = sanitizeHnHtml(
    '<p onclick="alert(1)">Hello<script>alert(2)</script> <a href="javascript:alert(3)">bad</a> <a href="https://example.com">good</a></p>',
  );
  assert.doesNotMatch(safe, /script|onclick|javascript/i);
  assert.match(safe, /href="https:\/\/example.com"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
});

test("truncates to 200 visible words and leaves valid closing tags", () => {
  const longHtml = `<p><strong>${Array.from({ length: 205 }, (_, index) => `word${index}`).join(" ")}</strong></p>`;
  const truncated = truncateHtmlWords(longHtml, 200);
  assert.equal(htmlToPlainText(truncated).replace("…", "").match(/\S+/g)?.length, 200);
  assert.match(truncated, /…<\/strong><\/p>$/);
  assert.doesNotMatch(truncated, /word204/);
});
