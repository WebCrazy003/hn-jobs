import sanitizeHtml from "sanitize-html";
import { decode } from "entities";
import type { ParsedJob } from "./types.ts";

const allowedTags = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "code",
  "pre",
  "a",
  "blockquote",
];

const rolePattern = /\b(engineer|developer|designer|product|data|scientist|manager|member of technical staff|architect|devops|sre|researcher|analyst)\b/i;
const employmentPattern = /^(full[- ]?time|part[- ]?time|contract|intern(ship)?|permanent)$/i;

const technologyAliases: Array<[string, string[]]> = [
  ["TypeScript", ["TypeScript"]],
  ["JavaScript", ["JavaScript", "JS"]],
  ["Python", ["Python"]],
  ["Go", ["Golang", "Go"]],
  ["Rust", ["Rust"]],
  ["Java", ["Java"]],
  ["C#", ["C#", "C Sharp"]],
  ["C++", ["C++"]],
  ["Ruby", ["Ruby"]],
  ["Rails", ["Ruby on Rails", "Rails"]],
  ["PHP", ["PHP"]],
  ["Kotlin", ["Kotlin"]],
  ["Elixir", ["Elixir"]],
  ["React Native", ["React Native"]],
  ["React", ["React", "React.js", "ReactJS"]],
  ["Vue", ["Vue", "Vue.js", "VueJS"]],
  ["Angular", ["Angular"]],
  ["Svelte", ["Svelte"]],
  ["Astro", ["Astro"]],
  ["Node.js", ["Node.js", "NodeJS"]],
  ["Next.js", ["Next.js", "NextJS"]],
  ["Postgres", ["PostgreSQL", "Postgres"]],
  ["MySQL", ["MySQL"]],
  ["MongoDB", ["MongoDB"]],
  ["SQLite", ["SQLite"]],
  ["Redis", ["Redis"]],
  ["SQL", ["SQL"]],
  ["Pandas", ["Pandas"]],
  ["AWS", ["AWS", "Amazon Web Services"]],
  ["GCP", ["GCP", "Google Cloud Platform"]],
  ["Azure", ["Azure"]],
  ["Docker", ["Docker"]],
  ["Kubernetes", ["Kubernetes", "K8s"]],
  ["Terraform", ["Terraform"]],
  ["PyTorch", ["PyTorch"]],
  ["TensorFlow", ["TensorFlow"]],
  ["GraphQL", ["GraphQL"]],
  ["Kafka", ["Kafka"]],
  ["ROS", ["ROS2", "ROS"]],
  ["Cloudflare Workers", ["Cloudflare Workers"]],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAlias(text: string, alias: string): boolean {
  const escaped = escapeRegExp(alias);
  return new RegExp(`(^|[^A-Za-z0-9+#])${escaped}(?=$|[^A-Za-z0-9+#])`, "i").test(text);
}

export function sanitizeHnHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    },
  }).trim();
}

export function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|pre|blockquote)>/gi, "\n")
    .replace(/<(p|li|ul|ol|pre|blockquote)(?:\s[^>]*)?>/gi, "\n");
  return decode(
    sanitizeHtml(withBreaks, {
      allowedTags: [],
      allowedAttributes: {},
    }),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTitleAndContent(sanitizedHtml: string): { titleHtml: string; contentHtml: string } {
  const html = sanitizedHtml.trim();
  const leadingParagraph = html.match(/^<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i);
  if (leadingParagraph) {
    return {
      titleHtml: leadingParagraph[1] || "",
      contentHtml: html.slice(leadingParagraph[0].length).trim(),
    };
  }

  const boundary = /<(p|ul|ol|pre|blockquote)(?:\s[^>]*)?>|<br\s*\/?>/i.exec(html);
  if (!boundary || boundary.index === undefined) {
    return { titleHtml: html, contentHtml: "" };
  }

  const titleHtml = html.slice(0, boundary.index);
  const boundaryTag = boundary[0].toLowerCase();
  const contentStart = boundaryTag.startsWith("<br")
    ? boundary.index + boundary[0].length
    : boundary.index;
  return { titleHtml, contentHtml: html.slice(contentStart).trim() };
}

export function truncateHtmlWords(html: string, maximumWords = 200): string {
  const totalWords = htmlToPlainText(html).match(/\S+/g)?.length || 0;
  if (totalWords <= maximumWords) return html;

  const tokens = html.split(/(<[^>]+>)/g);
  const openTags: string[] = [];
  let words = 0;
  let output = "";

  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith("<")) {
      const closing = token.match(/^<\/([a-z0-9]+)/i);
      const opening = token.match(/^<([a-z0-9]+)/i);
      if (closing) {
        const tag = closing[1].toLowerCase();
        const index = openTags.lastIndexOf(tag);
        if (index >= 0) openTags.splice(index, 1);
      } else if (opening && !["br"].includes(opening[1].toLowerCase())) {
        openTags.push(opening[1].toLowerCase());
      }
      output += token;
      continue;
    }

    const matches = [...token.matchAll(/\S+/g)];
    if (words + matches.length < maximumWords) {
      words += matches.length;
      output += token;
      continue;
    }

    const wordsNeeded = maximumWords - words;
    const lastMatch = matches[wordsNeeded - 1];
    if (lastMatch?.index !== undefined) {
      output += token.slice(0, lastMatch.index + lastMatch[0].length).trimEnd();
    }
    output += "…";
    break;
  }

  for (const tag of openTags.reverse()) output += `</${tag}>`;
  return output;
}

function extractRoles(titleSegments: string[], plainText: string): string[] {
  const roles = new Set<string>();
  for (const segment of titleSegments.slice(1)) {
    const candidate = segment.trim();
    if (candidate && rolePattern.test(candidate)) roles.add(candidate);
  }

  const labeledLine = /^(?:hiring|roles|open roles|open positions|positions)\s*:\s*(.+)$/gim;
  for (const match of plainText.matchAll(labeledLine)) {
    for (const rawCandidate of match[1].split(/[,;•]|\s+-\s+/)) {
      const candidate = rawCandidate
        .trim()
        .split(/\.\s+(?=[A-Z][A-Za-z+#.]*)/)[0]
        .replace(/[.\s]+$/, "");
      if (candidate && rolePattern.test(candidate)) roles.add(candidate);
    }
  }
  return [...roles].slice(0, 32);
}

function extractLocation(titleSegments: string[], roles: string[]): string | null {
  const explicitIndex = titleSegments.findIndex(
    (segment, index) => index > 0 && /\b(remote|onsite|on-site|hybrid)\b/i.test(segment),
  );
  if (explicitIndex > 0) {
    const explicit = titleSegments[explicitIndex].trim();
    const modeResidue = explicit
      .replace(/\b(fully|remote|onsite|on-site|hybrid|or|and)\b/gi, "")
      .replace(/[\s/,&:()-]/g, "");
    const previous = titleSegments[explicitIndex - 1]?.trim();
    if (
      !modeResidue &&
      previous &&
      explicitIndex > 1 &&
      !rolePattern.test(previous) &&
      !employmentPattern.test(previous) &&
      !/^https?:\/\//i.test(previous)
    ) {
      return `${previous} | ${explicit}`;
    }
    return explicit;
  }

  const roleSet = new Set(roles.map((role) => role.toLowerCase()));
  const fallback = titleSegments.slice(1).find((segment) => {
    const candidate = segment.trim();
    return (
      candidate &&
      !roleSet.has(candidate.toLowerCase()) &&
      !rolePattern.test(candidate) &&
      !employmentPattern.test(candidate) &&
      !/^https?:\/\//i.test(candidate)
    );
  });
  return fallback?.trim() || null;
}

export function parseJobPost(rawHtml: string): ParsedJob {
  const sanitizedHtml = sanitizeHnHtml(rawHtml);
  const { titleHtml, contentHtml } = splitTitleAndContent(sanitizedHtml);
  const titleText = htmlToPlainText(titleHtml).replace(/\s+/g, " ").trim();
  const plainText = htmlToPlainText(sanitizedHtml);
  const titleSegments = titleText.split("|").map((segment) => segment.trim()).filter(Boolean);
  const company = titleSegments[0] || null;
  const roles = extractRoles(titleSegments, plainText);
  const locationText = extractLocation(titleSegments, roles);
  const technologies = technologyAliases
    .filter(([, aliases]) => aliases.some((alias) => containsAlias(plainText, alias)))
    .map(([canonical]) => canonical);

  return {
    rawHtml,
    sanitizedHtml,
    plainText,
    titleText: titleText || "Untitled HN job post",
    contentHtml,
    contentPreviewHtml: truncateHtmlWords(contentHtml, 200),
    company,
    roles,
    locationText,
    technologies,
  };
}
