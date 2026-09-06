#!/usr/bin/env node

import { openPostArchive } from "./archive.mjs";

const argv = process.argv.slice(2);
const command = argv.shift();

if (!command || command === "--help" || command === "help") {
  usage();
  process.exit(0);
}

const options = parseArgs(argv);
const archive = await openPostArchive(options.db ?? "result/facebook-posts.sqlite");
try {
  if (command === "import") {
    if (options.positionals.length === 0) throw new Error("import requires at least one exported JSON file");
    const result = archive.importFiles(options.positionals, { writtenAt: options.writtenAt });
    print(result, options.json);
  } else if (command === "latest") {
    const result = archive.latest({ limit: options.limit, groupUrl: options.group });
    printObservations(result, options.json);
  } else if (command === "history") {
    const identity = options.url ?? options.key ?? options.positionals[0];
    if (!identity) throw new Error("history requires --url <post-url>, --key <post-key>, or a positional URL/key");
    const result = archive.history(identity, { limit: options.limit });
    printObservations(result, options.json);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  archive.close();
}

function parseArgs(args) {
  const options = { positionals: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") options.json = true;
    else if (["--db", "--written-at", "--limit", "--group", "--url", "--key"].includes(value)) {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      index += 1;
      const name = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[name] = next;
    } else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else options.positionals.push(value);
  }
  return options;
}

function print(value, asJson) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else console.table([value]);
}

function printObservations(observations, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(observations, null, 2)}\n`);
    return;
  }
  console.table(observations.map((item) => ({
    post_key: item.post_key,
    written_at: item.written_at,
    scraped_at: item.scraped_at,
    author: item.author_name,
    post_url: item.post_url,
    content: item.content_text.length > 100 ? `${item.content_text.slice(0, 97)}...` : item.content_text,
  })));
}

function usage() {
  process.stdout.write(`Usage:
  npm run archive -- import <export.json> [more.json ...] [--db result/facebook-posts.sqlite]
  npm run archive -- latest [--db result/facebook-posts.sqlite] [--group <group-url>] [--limit 50] [--json]
  npm run archive -- history --url <post-url> [--db result/facebook-posts.sqlite] [--limit 50] [--json]
  npm run archive -- history --key <post-key> [--db result/facebook-posts.sqlite] [--limit 50] [--json]
`);
}
