#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CATALOG_URL = new URL("./novels.js", import.meta.url);
const SITEMAP_URL = "https://yukikitsuneko.blogspot.com/sitemap-pages.xml";
const PAGE_FEED_URL =
  "https://yukikitsuneko.blogspot.com/feeds/pages/default?alt=json";
const FEED_PAGE_SIZE = 500;

const EXCLUDED_PAGE_PATHS = new Set([
  "/p/about.html",
  "/p/dmca.html",
  "/p/series-list.html",
]);

const GENRE_ALIASES = new Map([
  ["Childhood Friends", "Childhood Friend"],
  ["Coming-of-age", "Coming of Age"],
  ["Echii", "Ecchi"],
  ["R18", "R-18"],
  ["Shonen", "Shounen"],
]);

const TYPE_ALIASES = new Map([
  ["light novel", "Light Novel"],
  ["light/web novel", "Light/Web Novel"],
  ["manga", "Manga"],
  ["web novel", "Web Novel"],
]);

const TYPE_GENRES = new Set(TYPE_ALIASES.values());

const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};

function showUsage() {
  console.log("Usage: node sync-novels.mjs [--dry-run | --write]");
}

function parseArguments(argv) {
  const validArguments = new Set(["--dry-run", "--write", "--help"]);
  const unknownArguments = argv.filter((argument) => !validArguments.has(argument));

  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
  }

  if (argv.includes("--help")) {
    showUsage();
    process.exit(0);
  }

  if (argv.includes("--dry-run") && argv.includes("--write")) {
    throw new Error("Use either --dry-run or --write, not both.");
  }

  return { write: argv.includes("--write") };
}

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&([a-z]+);/gi, (entity, name) =>
      Object.hasOwn(HTML_ENTITIES, name.toLowerCase())
        ? HTML_ENTITIES[name.toLowerCase()]
        : entity,
    );
}

function stripMarkup(value) {
  return decodeHtml(
    value
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTag(html, tagName) {
  const match = html.match(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"),
  );
  return match ? stripMarkup(match[1]) : null;
}

function extractField(html, fieldName) {
  const escapedName = escapeRegExp(fieldName);
  const definitionListMatch = html.match(
    new RegExp(
      `<dt\\b[^>]*>\\s*${escapedName}\\s*<\\/dt>\\s*<dd\\b[^>]*>([\\s\\S]*?)<\\/dd>`,
      "i",
    ),
  );

  if (definitionListMatch) {
    return stripMarkup(definitionListMatch[1]);
  }

  const legacyMatch = html.match(
    new RegExp(
      `<strong\\b[^>]*>\\s*${escapedName}\\s*:\\s*<\\/strong>([\\s\\S]*?)<\\/div>`,
      "i",
    ),
  );
  return legacyMatch ? stripMarkup(legacyMatch[1]) : null;
}

function extractImageUrl(html) {
  const imageMatch = html.match(/<img\b[^>]*\bsrc=(['"])(.*?)\1/i);
  return imageMatch ? decodeHtml(imageMatch[2]) : null;
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

function canonicalStatus(value) {
  const key = value.toLowerCase().replace(/[\s-]+/g, "");
  const statuses = {
    axed: "Axed",
    complete: "Completed",
    completed: "Completed",
    ongoing: "Ongoing",
    oneshot: "One Shot",
  };

  if (!Object.hasOwn(statuses, key)) {
    throw new Error(`Unknown status: ${value}`);
  }

  return statuses[key];
}

function canonicalType(value) {
  const type = TYPE_ALIASES.get(value.toLowerCase());
  if (!type) {
    throw new Error(`Unknown type: ${value}`);
  }
  return type;
}

function canonicalGenres(value) {
  const genres = value
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean)
    .map((genre) => GENRE_ALIASES.get(genre) ?? genre)
    .filter((genre) => !TYPE_GENRES.has(genre));

  return [...new Set(genres)];
}

function alternateUrl(entry) {
  const alternateLink = entry.link?.find((link) => link.rel === "alternate");
  return alternateLink ? canonicalUrl(alternateLink.href) : null;
}

function extractRecord(entry) {
  const html = entry.content?.$t ?? "";
  const link = alternateUrl(entry);
  const title = extractTag(html, "h1");
  const imageUrl = extractImageUrl(html);
  const genreValue = extractField(html, "Genre");
  const typeValue = extractField(html, "Type");
  const statusValue = extractField(html, "Status");

  const missingFields = Object.entries({
    link,
    title,
    imageUrl,
    genre: genreValue,
    type: typeValue,
    status: statusValue,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingFields.length > 0) {
    throw new Error(
      `Could not extract ${missingFields.join(", ")} from ${link ?? entry.title?.$t}`,
    );
  }

  const record = {
    imageUrl,
    title,
    link,
    genre: canonicalGenres(genreValue),
    type: canonicalType(typeValue),
    status: canonicalStatus(statusValue),
  };

  validateRecord(record);
  return record;
}

function validateRecord(record) {
  const stringFields = ["imageUrl", "title", "link", "type", "status"];
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      throw new Error(`Record has an invalid ${field}: ${record.link ?? record.title}`);
    }
  }

  for (const field of ["imageUrl", "link"]) {
    const url = new URL(record[field]);
    if (url.protocol !== "https:") {
      throw new Error(`Record has a non-HTTPS ${field}: ${record[field]}`);
    }
  }

  if (!Array.isArray(record.genre) || record.genre.length === 0) {
    throw new Error(`Record has no genres: ${record.link}`);
  }

  if (new Set(record.genre).size !== record.genre.length) {
    throw new Error(`Record has duplicate genres: ${record.link}`);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "fantl-data-sync/1.0" },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return response.text();
}

async function fetchPageEntries() {
  const entries = [];

  for (let startIndex = 1; ; startIndex += FEED_PAGE_SIZE) {
    const url = new URL(PAGE_FEED_URL);
    url.searchParams.set("max-results", String(FEED_PAGE_SIZE));
    url.searchParams.set("start-index", String(startIndex));

    const page = JSON.parse(await fetchText(url));
    const pageEntries = page.feed?.entry ?? [];
    entries.push(...pageEntries);

    if (pageEntries.length < FEED_PAGE_SIZE) {
      return entries;
    }
  }
}

function loadCatalog(source) {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: fileURLToPath(CATALOG_URL) });

  if (!Array.isArray(sandbox.window.novelData)) {
    throw new Error("novels.js did not define window.novelData as an array.");
  }

  return sandbox.window.novelData;
}

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
    .map((match) => canonicalUrl(decodeHtml(match[1])))
    .filter((url) => !EXCLUDED_PAGE_PATHS.has(new URL(url).pathname));
}

function formatRecord(record) {
  return JSON.stringify(record, null, 2)
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

function appendRecords(source, records) {
  if (records.length === 0) {
    return source;
  }

  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const closingMarker = "\n    ];";
  const closingIndex = normalizedSource.lastIndexOf(closingMarker);

  if (closingIndex < 0) {
    throw new Error("Could not find the end of window.novelData.");
  }

  const beforeClosing = normalizedSource.slice(0, closingIndex).trimEnd();
  const afterClosing = normalizedSource.slice(closingIndex);
  const addition = records.map(formatRecord).join(",\n");
  const updated = `${beforeClosing},\n${addition}${afterClosing}`;

  return updated.replace(/\n/g, lineEnding);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(CATALOG_URL, "utf8");
  const catalog = loadCatalog(source);
  const knownUrls = new Set(catalog.map((record) => canonicalUrl(record.link)));

  const [sitemap, entries] = await Promise.all([
    fetchText(SITEMAP_URL),
    fetchPageEntries(),
  ]);

  const entryByUrl = new Map(
    entries
      .map((entry) => [alternateUrl(entry), entry])
      .filter(([url]) => url !== null),
  );
  const missingUrls = sitemapUrls(sitemap).filter((url) => !knownUrls.has(url));
  const missingEntries = missingUrls.map((url) => {
    const entry = entryByUrl.get(url);
    if (!entry) {
      throw new Error(`The page feed did not contain sitemap URL: ${url}`);
    }
    return entry;
  });

  missingEntries.sort(
    (left, right) =>
      Date.parse(left.published?.$t ?? 0) - Date.parse(right.published?.$t ?? 0),
  );

  const records = missingEntries.map(extractRecord);
  const combinedUrls = new Set([
    ...knownUrls,
    ...records.map((record) => canonicalUrl(record.link)),
  ]);

  if (combinedUrls.size !== catalog.length + records.length) {
    throw new Error("Duplicate catalog URLs detected after synchronization.");
  }

  if (!options.write) {
    console.log(JSON.stringify(records, null, 2));
    console.error(`Dry run: ${records.length} missing novel(s). No files changed.`);
    return;
  }

  if (records.length === 0) {
    console.log("novels.js is already synchronized.");
    return;
  }

  await writeFile(CATALOG_URL, appendRecords(source, records), "utf8");
  console.log(`Added ${records.length} novel(s) to novels.js.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
