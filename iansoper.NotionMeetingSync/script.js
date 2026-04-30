// ============================================================
// Notion Meeting Sync — NotePlan Plugin v1.11.0
// Syncs TWO sources into a configurable NotePlan folder:
//   1. Ian's Fireflies Meetings database
//   2. Native Notion meeting recordings
// Settings are stored via NotePlan's native plugin settings.
// ============================================================

var FIREFLIES_DB_ID = "30d1bad57c4381eb8b06c38b1b6e6311";
var DEFAULT_FOLDER = "Meetings";
var NOTION_VERSION = "2022-06-28";

// ─── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log("[NotionSync] " + msg);
}

function logError(context, err) {
  console.log(
    "[NotionSync] ERROR in " +
      context +
      ": " +
      (err && err.message ? err.message : String(err)),
  );
  if (err && err.stack) console.log("[NotionSync] Stack: " + err.stack);
}

// ─── Settings (via NotePlan native plugin.settings) ────────────────────────────

function getToken() {
  var s = DataStore.settings;
  if (!s) {
    log("WARNING: DataStore.settings is null");
    return null;
  }
  if (!s.notionToken || !s.notionToken.trim()) {
    log("WARNING: notionToken is empty in plugin settings");
    return null;
  }
  log("Token found: " + s.notionToken.trim().substring(0, 14) + "…");
  return s.notionToken.trim();
}

function getTargetFolder() {
  var s = DataStore.settings;
  var folder = s && s.targetFolder ? s.targetFolder.trim() : "";
  var result = folder || DEFAULT_FOLDER;
  log("Target folder: " + result);
  return result;
}

function getLastSync() {
  // Try plugin settings first, then preference store
  var val = null;
  try {
    var s = DataStore.settings;
    if (s && s.lastSync && s.lastSync.trim()) val = s.lastSync.trim();
  } catch (e) {}
  if (!val) {
    try {
      var pref = DataStore.preference("lastSync");
      if (pref && pref.trim()) val = pref.trim();
    } catch (e) {}
  }
  log("Last sync: " + (val || "none — will do full sync"));
  return val;
}

function saveLastSync(isoDate) {
  try {
    DataStore.setPreference("lastSync", isoDate);
    log("Saved last sync timestamp via setPreference: " + isoDate);
  } catch (e) {
    log("WARNING: could not save lastSync: " + e.message);
  }
}

// ─── Notion API ────────────────────────────────────────────────────────────────

async function notionFetch(url, token, body) {
  log("Fetching: " + url);
  var opts = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  // NotePlan's plugin runtime returns the response body directly as a string,
  // not a standard fetch Response object. We use CallbackURL / fetch which
  // resolves to { data, status, error } or just the raw string depending on version.
  var result;
  try {
    result = await fetch(url, opts);
  } catch (e) {
    throw new Error("Network error fetching " + url + ": " + e.message);
  }

  log("Raw result type: " + typeof result);

  // Handle different return shapes from the NotePlan runtime
  var raw;
  var status;
  if (typeof result === "string") {
    // Older runtime: returns raw JSON string directly
    raw = result;
    status = 200;
  } else if (result && typeof result === "object") {
    if (result.error) {
      throw new Error("Fetch error from " + url + ": " + result.error);
    }
    // May have .data (string) and .status
    raw =
      result.data ||
      result.body ||
      result.responseText ||
      JSON.stringify(result);
    status = result.status || result.statusCode || 200;
  } else {
    throw new Error(
      "Unexpected fetch result type: " + typeof result + " from " + url,
    );
  }

  log("HTTP status: " + status);

  if (status && status >= 400) {
    var snippet =
      typeof raw === "string"
        ? raw.substring(0, 300)
        : JSON.stringify(raw).substring(0, 300);
    throw new Error("Notion " + status + " from " + url + ": " + snippet);
  }

  var parsed;
  try {
    parsed = typeof raw === "object" ? raw : JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "Failed to parse JSON from " +
        url +
        ": " +
        e.message +
        ". Raw: " +
        String(raw).substring(0, 200),
    );
  }

  log("Response OK from: " + url);
  return parsed;
}

// ─── SOURCE 1: Fireflies database ─────────────────────────────────────────────

async function fetchFirefliesPages(token, filterAfter) {
  log("--- Fetching Fireflies database ---");
  var payload = {
    page_size: 50,
    sorts: [{ property: "Date", direction: "descending" }],
  };
  if (filterAfter && filterAfter.length > 5) {
    payload.filter = {
      property: "Date",
      date: { on_or_after: filterAfter.substring(0, 10) },
    };
    log("Filtering Fireflies by date >= " + filterAfter.substring(0, 10));
  } else {
    log("No date filter — fetching all Fireflies meetings");
  }
  var data = await notionFetch(
    "https://api.notion.com/v1/databases/" + FIREFLIES_DB_ID + "/query",
    token,
    payload,
  );
  log("Fireflies raw keys: " + Object.keys(data).join(", "));
  var pages = Array.prototype.slice.call(data.results || []);
  log("Fireflies: found " + pages.length + " pages");
  if (pages.length > 0)
    log(
      "First page title: " +
        (pages[0].properties && pages[0].properties["Title"]
          ? "present"
          : "missing"),
    );
  return pages;
}

// ─── SOURCE 2: Native Notion meeting pages ─────────────────────────────────────

async function fetchNativeMeetingPages(token, filterAfter) {
  log("--- Fetching native Notion meeting pages ---");
  var payload = {
    filter: { value: "page", property: "object" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 50,
  };
  var data = await notionFetch(
    "https://api.notion.com/v1/search",
    token,
    payload,
  );
  log("Search raw keys: " + Object.keys(data).join(", "));
  var pages = Array.prototype.slice.call(data.results || []);
  log("Search returned " + pages.length + " total pages before filtering");
  if (pages.length > 0) {
    log(
      "Sample titles: " +
        pages
          .slice(0, 3)
          .map(function (p) {
            return '"' + getPageTitle(p) + '"';
          })
          .join(", "),
    );
  }

  // NOTE: We intentionally skip the date filter for native meetings.
  // These pages were created historically and won't appear in a recent lastSync window.
  // We use URL-based deduplication in runSync to avoid unnecessary rewrites.
  log("Skipping date filter for native meetings (using URL dedup instead)");

  // Titles may contain ISO timestamps like "**2025-08-27T15:16:00.000-04:00**"
  // or plain month names like "August 27, 2025" — match both
  var isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  var monthPattern =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/;
  var before2 = pages.length;
  pages = pages.filter(function (p) {
    var t = getPageTitle(p);
    return isoPattern.test(t) || monthPattern.test(t);
  });
  log(
    "Meeting-pattern filter: " +
      (before2 - pages.length) +
      " removed, " +
      pages.length +
      " native meeting pages remain",
  );
  pages.forEach(function (p) {
    log('  Native page: "' + getPageTitle(p) + '"');
  });
  return pages;
}

// ─── Rich text & block helpers ─────────────────────────────────────────────────

function rt(arr) {
  if (!arr || !arr.length) return "";
  return arr
    .map(function (t) {
      var s = t.plain_text || "";
      if (t.annotations) {
        if (t.annotations.bold) s = "**" + s + "**";
        if (t.annotations.italic) s = "_" + s + "_";
        if (t.annotations.code) s = "`" + s + "`";
        if (t.annotations.strikethrough) s = "~~" + s + "~~";
      }
      return s;
    })
    .join("");
}

function getPageTitle(page) {
  var props = page.properties || {};
  var titleProp = props["title"] || props["Title"] || props["Name"];
  if (titleProp && titleProp.title) return rt(titleProp.title);
  if (titleProp && titleProp.rich_text) return rt(titleProp.rich_text);
  return "Untitled";
}

async function getBlocks(token, pageId) {
  var id = pageId.replace(/-/g, "");
  var data = await notionFetch(
    "https://api.notion.com/v1/blocks/" + id + "/children?page_size=100",
    token,
    null,
  );
  // Force to a real Array — the runtime may return an array-like object
  var raw = data.results || [];
  return Array.prototype.slice.call(raw);
}

function blocksToLines(blocks, depth) {
  depth = depth || 0;
  var pad = "  ".repeat(depth);
  var out = [];
  // Use a for loop — forEach may not be available on array-like objects in this runtime
  var safeBlocks = blocks ? Array.prototype.slice.call(blocks) : [];
  for (var _i = 0; _i < safeBlocks.length; _i++) {
    (function (block) {
      var type = block.type;
      var data = block[type] || {};
      var text = data.rich_text ? rt(data.rich_text) : "";
      switch (type) {
        case "heading_1":
          out.push(pad + "# " + text);
          break;
        case "heading_2":
          out.push(pad + "## " + text);
          break;
        case "heading_3":
          out.push(pad + "### " + text);
          break;
        case "paragraph":
          if (text) out.push(pad + text);
          break;
        case "bulleted_list_item":
          out.push(pad + "- " + text);
          break;
        case "numbered_list_item":
          out.push(pad + "1. " + text);
          break;
        case "to_do":
          out.push(pad + "* [" + (data.checked ? "x" : " ") + "] " + text);
          break;
        case "toggle":
          out.push(pad + "### " + text);
          break;
        case "callout":
          out.push(pad + "> " + text);
          break;
        case "quote":
          out.push(pad + "> " + text);
          break;
        case "divider":
          out.push("---");
          break;
        case "code":
          out.push("```");
          out.push(text);
          out.push("```");
          break;
        default:
          if (text) out.push(pad + text);
      }
      if (block.has_children && data.children) {
        out = out.concat(
          blocksToLines(Array.prototype.slice.call(data.children), depth + 1),
        );
      }
    })(safeBlocks[_i]);
  }
  return out;
}

// ─── Property extraction ───────────────────────────────────────────────────────

function propVal(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return rt(prop.title);
    case "rich_text":
      return rt(prop.rich_text);
    case "date":
      return prop.date ? prop.date.start : "";
    case "multi_select":
      return (prop.multi_select || [])
        .map(function (o) {
          return o.name;
        })
        .join(", ");
    case "select":
      return prop.select ? prop.select.name : "";
    case "url":
      return prop.url || "";
    default:
      return "";
  }
}

// ─── Task conversion ───────────────────────────────────────────────────────────

function toTasks(rawText) {
  return (rawText || "")
    .split("\n")
    .map(function (l) {
      return l.trim();
    })
    .filter(Boolean)
    .map(function (l) {
      var checked = /^\[x\]/i.test(l) || /^[-*]\s*\[x\]/i.test(l);
      var clean = l
        .replace(/^[-*•]\s*/, "")
        .replace(/^\[[ x]?\]\s*/i, "")
        .replace(/\[\^https?:\/\/[^\]]*\]/g, "")
        .trim();
      return "* [" + (checked ? "x" : " ") + "] " + clean;
    });
}

// ─── Attendee @mentions ────────────────────────────────────────────────────────

function attendeesToMentions(attendees) {
  if (!attendees) return "";
  return attendees
    .split(",")
    .map(function (name) {
      var first = name.trim().split(/\s+/)[0];
      first = first.replace(/[^a-zA-Z0-9]/g, "");
      return first ? "@" + first : "";
    })
    .filter(Boolean)
    .join(" ");
}

// ─── Note naming ───────────────────────────────────────────────────────────────

function makeNoteName(title, dateStr) {
  var cleanTitle = title
    // Strip ISO timestamps like "2025-08-27T15:16:00.000-04:00"
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}/g, "")
    // Strip bold markdown wrappers
    .replace(/\*\*/g, "")
    // Strip month-name dates
    .replace(
      /@?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}[^a-zA-Z]*/gi,
      "",
    )
    .replace(/[\/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanTitle) cleanTitle = "Meeting";
  var d = dateStr ? dateStr.substring(0, 10) : "";
  return d ? d + " " + cleanTitle : cleanTitle;
}

function extractDateFromTitle(title) {
  // Try ISO timestamp first: "2025-08-27T15:16:00.000-04:00"
  var iso = title.match(/(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
  if (iso) return iso[1];
  // Fall back to month-name format: "August 27, 2025"
  var months = {
    January: "01",
    February: "02",
    March: "03",
    April: "04",
    May: "05",
    June: "06",
    July: "07",
    August: "08",
    September: "09",
    October: "10",
    November: "11",
    December: "12",
  };
  var m = title.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/,
  );
  if (!m) return "";
  return m[3] + "-" + months[m[1]] + "-" + m[2].padStart(2, "0");
}

// ─── Note builders ─────────────────────────────────────────────────────────────

async function buildFirefliesNote(page, token) {
  var p = page.properties || {};
  var title = propVal(p["Title"]) || "Untitled Meeting";
  var date = propVal(p["Date"]) || "";
  var attendees = propVal(p["Attendees"]) || "";
  var host = propVal(p["Host"]) || "";
  var gist = propVal(p["Gist"]) || "";
  var overview = propVal(p["Overview"]) || "";
  var bulletNotes = propVal(p["Bullet Notes"]) || "";
  var newSummary = propVal(p["New Summary"]) || "";
  var actionItems = propVal(p["Action Items"]) || "";
  var transcript = propVal(p["Transcript"]) || "";
  var notionUrl = page.url || "";
  var dateShort = date ? date.substring(0, 10) : "";

  log('Building Fireflies note: "' + title + '" (' + dateShort + ")");
  log("  attendees: " + (attendees || "none"));
  log(
    "  actionItems: " +
      (actionItems ? actionItems.substring(0, 80) + "…" : "none"),
  );

  var bodyLines = [];
  try {
    bodyLines = blocksToLines(await getBlocks(token, page.id), 0);
    log("  body blocks: " + bodyLines.length + " lines");
  } catch (e) {
    logError("getBlocks(Fireflies/" + title + ")", e);
    bodyLines = ["> ⚠️ Could not fetch page body: " + e.message];
  }

  var summaryParts = [gist];
  if (newSummary && newSummary !== gist) summaryParts.push(newSummary);
  if (overview && overview !== gist) summaryParts.push(overview);

  return assembleNote({
    title: title,
    dateShort: dateShort,
    attendees: attendees,
    host: host,
    source: "fireflies",
    notionUrl: notionUrl,
    transcript: transcript,
    actionItems: actionItems,
    summaryParts: summaryParts.filter(Boolean),
    bulletNotes: bulletNotes,
    bodyLines: bodyLines,
  });
}

async function buildNativeNote(page, token) {
  var rawTitle = getPageTitle(page);
  var dateShort = extractDateFromTitle(rawTitle);
  var notionUrl = page.url || "";

  log('Building native note: "' + rawTitle + '" (' + dateShort + ")");

  var blocks = [];
  try {
    blocks = await getBlocks(token, page.id);
    log("  fetched " + blocks.length + " blocks");
  } catch (e) {
    logError("getBlocks(Native/" + rawTitle + ")", e);
  }

  var allLines = blocksToLines(blocks, 0);
  var inActions = false;
  var actionLines = [];
  var bodyLines = [];

  allLines.forEach(function (line) {
    if (/^#{1,3}\s*Action Items/i.test(line)) {
      inActions = true;
      return;
    }
    if (/^#{1,3}\s/.test(line)) {
      inActions = false;
    }
    if (inActions && (/^\*?\s*\[[ x]\]/.test(line) || /^-\s+/.test(line))) {
      actionLines.push(line);
    } else {
      bodyLines.push(line);
    }
  });

  log("  action items found: " + actionLines.length);
  log("  body lines: " + bodyLines.length);

  var cleanTitle = rawTitle
    // Strip ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}/g, "")
    // Strip bold markdown
    .replace(/\*\*/g, "")
    // Strip month-name dates
    .replace(
      /@?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}(\s+\d{1,2}:\d{2}\s*[AP]M)?(\s*\([^)]*\))?/gi,
      "",
    )
    .replace(/^\s*with\s+/i, "Meeting with ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanTitle) cleanTitle = "Notion Meeting";

  log('  clean title: "' + cleanTitle + '"');

  return assembleNote({
    title: cleanTitle,
    dateShort: dateShort,
    attendees: "",
    host: "",
    source: "notion",
    notionUrl: notionUrl,
    transcript: "",
    actionItems: actionLines.join("\n"),
    summaryParts: [],
    bulletNotes: "",
    bodyLines: bodyLines,
  });
}

// ─── Shared assembler ──────────────────────────────────────────────────────────

function assembleNote(opts) {
  var lines = [];
  lines.push("---");
  lines.push('title: "' + opts.title.replace(/"/g, "'") + '"');
  if (opts.dateShort) lines.push("date: " + opts.dateShort);
  if (opts.attendees) lines.push('attendees: "' + opts.attendees + '"');
  if (opts.host) lines.push('host: "' + opts.host + '"');
  lines.push("source: " + opts.source);
  lines.push("notion_url: " + opts.notionUrl);
  lines.push("synced: " + new Date().toISOString().substring(0, 10));
  lines.push("tags: meeting, notion-sync, " + opts.source);
  lines.push("---");
  lines.push("");
  lines.push("# " + opts.title);
  if (opts.dateShort) lines.push("*" + opts.dateShort + "*");
  if (opts.attendees) {
    lines.push("**Attendees:** " + opts.attendees);
    var mentions = attendeesToMentions(opts.attendees);
    if (mentions) lines.push(mentions);
  }
  if (opts.host) lines.push("**Host:** " + opts.host);
  lines.push("");

  if (opts.actionItems && opts.actionItems.trim()) {
    lines.push("## Action Items");
    toTasks(opts.actionItems).forEach(function (t) {
      lines.push(t);
    });
    lines.push("");
  }

  if (opts.summaryParts && opts.summaryParts.length) {
    lines.push("## Summary");
    opts.summaryParts.forEach(function (s) {
      lines.push(s);
    });
    lines.push("");
  }

  if (opts.bulletNotes) {
    lines.push("## Notes");
    opts.bulletNotes
      .split("\n")
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean)
      .forEach(function (l) {
        lines.push(l.charAt(0) === "-" ? l : "- " + l);
      });
    lines.push("");
  }

  var body = (opts.bodyLines || []).filter(Boolean);
  if (body.length) {
    lines.push("## Full Notes");
    body.forEach(function (l) {
      lines.push(l);
    });
    lines.push("");
  }

  lines.push("---");
  if (opts.notionUrl) lines.push("[View in Notion](" + opts.notionUrl + ")");
  if (opts.transcript) lines.push("[Transcript](" + opts.transcript + ")");
  return lines.join("\n");
}

// ─── Write note ────────────────────────────────────────────────────────────────

function writeNote(name, content, folder) {
  log('Writing note: "' + name + '" → ' + folder + "/");

  var note = null;
  try {
    note = DataStore.newNote(name, folder);
    log(
      "  newNote returned: type=" +
        typeof note +
        " val=" +
        JSON.stringify(note),
    );
  } catch (e) {
    log("  DataStore.newNote threw: " + e.message);
  }

  // Case 1: newNote returned a Note object
  if (note && typeof note === "object") {
    try {
      note.content = content;
      log(
        "  Set content on note object. filename=" + (note.filename || "none"),
      );
      return "created";
    } catch (e) {
      log("  Error setting content on object: " + e.message);
    }
  }

  // Case 2: newNote returned a filename string
  if (typeof note === "string" && note.length > 0) {
    log("  newNote returned string filename: " + note);
    try {
      var byFile = DataStore.noteByFilename(note, "Notes");
      if (byFile) {
        byFile.content = content;
        log("  Wrote via noteByFilename");
        return "created";
      }
    } catch (e) {
      log("  noteByFilename error: " + e.message);
    }
  }

  // Case 3: scan all project notes for title match
  log('  Scanning DataStore.projectNotes for "' + name + '"...');
  try {
    var all = Array.prototype.slice.call(DataStore.projectNotes || []);
    log("  projectNotes count: " + all.length);
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n && (n.title === name || n.title === name + ".md")) {
        n.content = content;
        log("  Found by scan: " + (n.filename || "no filename"));
        return "updated";
      }
    }
    // Log first 5 titles for debugging
    var sample = all.slice(0, 5).map(function (n) {
      return n ? '"' + n.title + '"' : "null";
    });
    log("  Not found. Sample titles: " + sample.join(", "));
  } catch (e) {
    log("  projectNotes scan error: " + e.message);
  }

  log('  ERROR: could not write "' + name + '" to "' + folder + '"');
  return "error";
}

// ─── Core sync ─────────────────────────────────────────────────────────────────

async function runSync(token, lastSync) {
  log("========== Notion Meeting Sync started ==========");
  var targetFolder = getTargetFolder();

  // Log all available folders so the user can verify the correct name
  var availableFolders = [];
  try {
    availableFolders = Array.prototype.slice.call(DataStore.folders || []);
    log("Available folders in vault: [" + availableFolders.join(", ") + "]");
  } catch (e) {
    log("WARNING: Could not list folders: " + e.message);
  }

  // Validate the target folder exists
  if (availableFolders.indexOf(targetFolder) === -1) {
    log(
      'WARNING: Folder "' +
        targetFolder +
        '" not found. Attempting to create it...',
    );
    try {
      DataStore.createFolder(targetFolder);
      log('Folder "' + targetFolder + '" created.');
    } catch (e) {
      logError("createFolder", e);
      await CommandBar.prompt(
        "Folder Not Found",
        'The folder "' +
          targetFolder +
          '" does not exist.\n\nAvailable folders:\n' +
          availableFolders.join("\n") +
          "\n\nPlease update your Sync Folder setting.",
      );
      return;
    }
  } else {
    log('Folder "' + targetFolder + '" exists ✓');
  }

  var created = 0,
    updated = 0,
    errors = 0;

  // ── Fireflies ──
  CommandBar.showLoading(true, "Fetching Fireflies meetings…");
  var firefliesPages = [];
  try {
    firefliesPages = await fetchFirefliesPages(token, lastSync);
  } catch (e) {
    logError("fetchFirefliesPages", e);
    await CommandBar.prompt(
      "Warning",
      "⚠️ Fireflies database error:\n" +
        e.message +
        "\n\nContinuing with native meetings.",
    );
  }

  for (var i = 0; i < firefliesPages.length; i++) {
    var fp = firefliesPages[i];
    var fprops = fp.properties || {};
    var ftitle = propVal(fprops["Title"]) || "Untitled Meeting";
    var fdate = propVal(fprops["Date"]) || "";
    CommandBar.showLoading(
      true,
      "Fireflies " +
        (i + 1) +
        "/" +
        firefliesPages.length +
        ": " +
        ftitle +
        "…",
    );
    try {
      var fc = await buildFirefliesNote(fp, token);
      var r = writeNote(makeNoteName(ftitle, fdate), fc, targetFolder);
      if (r === "created") created++;
      else if (r === "updated") updated++;
      else errors++;
    } catch (e) {
      logError('buildFirefliesNote("' + ftitle + '")', e);
      errors++;
    }
  }

  // ── Native Notion meetings ──
  CommandBar.showLoading(true, "Fetching native Notion meetings…");
  var nativePages = [];
  try {
    nativePages = await fetchNativeMeetingPages(token, lastSync);
  } catch (e) {
    logError("fetchNativeMeetingPages", e);
    await CommandBar.prompt(
      "Warning",
      "⚠️ Native Notion meetings error:\n" + e.message,
    );
  }

  // Deduplicate against Fireflies
  var seenUrls = {};
  firefliesPages.forEach(function (fp) {
    if (fp.url) seenUrls[fp.url] = true;
  });
  var beforeDedup = nativePages.length;
  nativePages = nativePages.filter(function (np) {
    return !seenUrls[np.url];
  });
  if (beforeDedup !== nativePages.length) {
    log(
      "Deduplication removed " +
        (beforeDedup - nativePages.length) +
        " pages already in Fireflies",
    );
  }

  for (var j = 0; j < nativePages.length; j++) {
    var np = nativePages[j];
    var ntitle = getPageTitle(np);
    var ndate = extractDateFromTitle(ntitle);
    CommandBar.showLoading(
      true,
      "Native " +
        (j + 1) +
        "/" +
        nativePages.length +
        ": " +
        ntitle.substring(0, 40) +
        "…",
    );
    try {
      var nc = await buildNativeNote(np, token);
      var nr = writeNote(makeNoteName(ntitle, ndate), nc, targetFolder);
      if (nr === "created") created++;
      else if (nr === "updated") updated++;
      else errors++;
    } catch (e) {
      logError('buildNativeNote("' + ntitle + '")', e);
      errors++;
    }
  }

  saveLastSync(new Date().toISOString());
  CommandBar.showLoading(false);

  log(
    "========== Sync complete: " +
      created +
      " created, " +
      updated +
      " updated, " +
      errors +
      " errors ==========",
  );

  var summaryMsg =
    "✅ Sync complete! → " +
    targetFolder +
    "/\n\n" +
    "• Fireflies: " +
    firefliesPages.length +
    " meeting" +
    (firefliesPages.length !== 1 ? "s" : "") +
    "\n" +
    "• Native Notion: " +
    nativePages.length +
    " meeting" +
    (nativePages.length !== 1 ? "s" : "") +
    "\n\n" +
    "→ " +
    created +
    " created  /  " +
    updated +
    " updated" +
    (errors ? "  /  ⚠️ " + errors + " errors (check console)" : "");
  log(summaryMsg);
  await CommandBar.prompt("Sync Complete", summaryMsg);
}

// ─── Commands ──────────────────────────────────────────────────────────────────

globalThis.syncNotionMeetings = async function () {
  log("syncNotionMeetings command triggered");
  var token = getToken();
  if (!token) {
    await CommandBar.prompt(
      "Token Missing",
      "No Notion API token found.\n\nGo to NotePlan Preferences → Plugins → Notion Meeting Sync → Settings and enter your token there.",
    );
    return;
  }
  try {
    await runSync(token, getLastSync());
  } catch (e) {
    logError("runSync (top level)", e);
    CommandBar.showLoading(false);
    await CommandBar.prompt(
      "Error",
      "❌ Unexpected error:\n" +
        e.message +
        "\n\nCheck the plugin console log for details.",
    );
  }
};

globalThis.SyncNotionMeetings = globalThis.syncNotionMeetings;

// Clear the last sync timestamp to force a full re-sync on next run
globalThis.clearLastSync = async function () {
  try {
    DataStore.setPreference("lastSync", "");
  } catch (e) {}
  log("Last sync timestamp cleared — next sync will be a full sync");
  await CommandBar.prompt(
    "Done",
    "Last sync timestamp cleared. The next sync will import all meetings.",
  );
};

// Required lifecycle stub — NotePlan calls this when settings change
globalThis.onSettingsUpdated = function () {
  log("Settings updated");
};
