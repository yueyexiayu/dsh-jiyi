<div align="center">
  <img src="docs/assets/hero.svg" width="100%" alt="jiyi: remember important facts across sessions, and recall them within scope. Original concept illustration, not an app screenshot." />
  <h1>jiyi · Memory</h1>
  <p><strong>Keep the facts that matter. Bring back the context that fits.</strong></p>
  <p>Traceable, scoped cross-session memory for DeepSeek Harness.</p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p><a href="package.json">v0.1.21</a> &nbsp;·&nbsp; <a href="LICENSE">MIT</a> &nbsp;·&nbsp; <a href="https://github.com/topics/dsh-plugin">dsh-plugin</a></p>
  <p><a href="#features">Features</a> · <a href="#how-it-works">How it works</a> · <a href="#quick-start">Quick start</a> · <a href="#configuration">Configuration</a> · <a href="#validation">Validation</a> · <a href="#faq">FAQ</a></p>
</div>

---

Stop repeating project conventions in every new conversation. After a normal user turn completes, jiyi extracts **facts with explicit user evidence** in the background. When relevant new input arrives, it retrieves within scope, independently checks support, and supplies the original memory. It does not dump all history into context or treat similarity as sufficient evidence.

> [!NOTE]
> **Local storage does not mean fully offline.** Memories, indexes and embeddings stay local. Extraction and relevance checks send the necessary content to your configured LLM provider using your existing authorization.

Background extraction and relevance checks use the configured model; their usage is no longer attributed to the originating task's cost ledger.

This version targets a DSH Host with cost admission removed. An older Host with cost-control admission may block background extraction or relevance checks because those requests no longer carry cost attribution; use a compatible Host.

For historical correction or cost-review pauses, jiyi recognizes continuation of the same task. Sources from an unverified continuation across pause reasons are retained and are not attributed to another task.

## Features

<table>
<tr>
<td width="33%"><strong>🧠 Cross-session memory</strong><br/><br/>Incremental extraction after normally completed turns, with user provenance, versions and supersession. No automatic bulk history import.</td>
<td width="33%"><strong>🎯 Scoped recall</strong><br/><br/>Global and current-project memory by default. Cross-project scope expands only for explicit references; ambiguity is not silently merged.</td>
<td width="33%"><strong>🧾 Source-grounded support</strong><br/><br/>An independent check validates <code>id / version / quote</code>. Unrecorded implementation details are not filled in.</td>
</tr>
<tr>
<td><strong>🗂️ A dedicated sidebar</strong><br/><br/>Create independent memories, inspect sources, correct or delete records, and manage aliases, failed jobs and model settings.</td>
<td><strong>🔎 Local hybrid retrieval</strong><br/><br/>SQLite, FTS5 and 384-dimensional MiniLM vectors work together. Similarity produces candidates, not permission to inject.</td>
<td><strong>🛠️ Automatic first</strong><br/><br/>Normal recall does not depend on the main model searching. <code>jiyi_search</code> is an explicit supplement. Errors and timeouts remain visible.</td>
</tr>
</table>

## How it works

![jiyi workflow: user evidence is extracted and stored locally; new input triggers scoped hybrid retrieval, independent support checks and original-fact references.](<docs/assets/workflow.en.svg>)

1. **Capture** explicit user facts, not assistant guesses.
2. **Retrieve** candidates through local indexes and embeddings after scope filtering.
3. **Check** whether the original text supports the actual question, including literal quote validation.
4. **Reference** original facts with provenance, as evidence rather than instructions—not as newly generated facts.

<details>
<summary><strong>Design boundaries: when will jiyi not inject?</strong></summary>

- Opening a session does not preload specific facts. Genuine new user input triggers automatic recall.
- A business code is not automatically an HTTP status. A representation convention does not prove an undocumented implementation. Explicit prohibitions, paraphrases and supported parts of mixed questions can provide evidence.
- Fabricated, duplicate, stale or invalid references fail. Timeouts and errors do not become “no relevant memory,” and the system does not fall back to injecting on similarity alone.
- Commands inside memories are not instructions, and assistant guesses are not user facts. The same version is not injected twice; tool continuations do not recursively trigger recall.
- Corrections and deletions affect future recall, not text already present in existing conversations.

</details>

## Quick start

### 0. Check your environment

| Requirement | Verified environment / notes |
| :--- | :--- |
| DSH desktop | An installed DeepSeek Harness; its Host, LLM, tool and sidebar SDKs are required |
| Platform | macOS arm64; other platforms are not claimed as verified |
| Runtime | Node 24.21 and Electron 44; Node 24 and npm must be on your command-line PATH |
| Models and accounts | Local MiniLM assets, plus network access and existing LLM-provider authorization |

This is a **desktop filesystem plugin**, not a standalone Node application. Back up an existing plugin, settings and SQLite data first; do not overwrite the data directory.

### 1. Install dependencies and model assets

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
git clone https://github.com/yueyexiayu/dsh-jiyi.git "$DSH_HOME/plugins/jiyi"
cd "$DSH_HOME/plugins/jiyi"

npm ci --prefix deps
node scripts/prepare-models.mjs
```

The installer explicitly downloads a **pinned revision** and verifies every file's size and SHA256. Existing assets are verified, not silently replaced; checksum errors stop installation. Assets total about 129 MiB, so allow time for the first download. Runtime model networking is disabled.

Resource definitions: [model manifest](<models/manifest.json>) · [dependency lockfile](<deps/package-lock.json>) · [installer](<scripts/prepare-models.mjs>)

### 2. Register as a desktop profile bundle

jiyi loads as a **desktop profile bundle**. Do not add a `cordis.patch.yml` `- insert:` for it; insert is obsolete and must not be used on this machine. Do not both bundle and insert the same id.

Add `jiyi` in **both** places in `$DSH_HOME/profiles/desktop/package.json`:

- `dependencies`: `"jiyi": "link:$DSH_HOME/plugins/jiyi"`
- `dsh.profile.bundles`: the string `"jiyi"`, matching the package name

Then install dependencies in that profile and confirm `node_modules/jiyi` resolves to the plugin:

```sh
cd "$DSH_HOME/profiles/desktop"
npm install
node -e "console.log(require.resolve('jiyi'))"
```

Do not `- insert:` the same id in desktop `cordis.patch.yml`. To change configuration, use an overlay line for that id only. Do not copy the package [bundle declaration](<cordis.patch.yml>) unchanged over the desktop profile.

### 3. Restart and verify

**Quit DSH fully with ⌘Q, then reopen it.** Use the application's normal authenticated “Open in browser” menu entry and open the memory sidebar:

- Confirm **Client / Host both report 0.1.21**.
- Configure and separately verify extraction, embedding and relevance models.
- Saving settings is not a successful model check. Do not share authentication-bearing browser links.

## Configuration

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| Extraction model | `deepseek-account/deepseek-flash` · 60000ms | Extract facts from explicit user evidence |
| Relevance model | `deepseek-account/deepseek-flash` · 10000ms | Independently check candidate support |
| Embedding | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | q8 CPU · 384 dimensions · local |
| Candidates / final memories | At most 12 / 6 | Bound judgment and injection counts |
| Semantic candidate threshold | `0.20` | Candidate generation only, not injection authorization |
| Injection budget | 4000 UTF-8 bytes | Includes metadata, sources and wrapping |
| Stale status age | 72 hours | Ranking penalty, not deletion |

<details>
<summary><strong>Data locations and resource limits</strong></summary>

- Data and settings live in `$DSH_HOME/storages/jiyi/`, outside Git, with directory/file modes 0700/0600. Do not commit databases, WAL files, credentials, private conversations or raw evaluation records.
- `/api/jiyi` uses normal DSH authentication. Credentials stay in the Host, not the Client.
- Default cold-load limit: 120 seconds. Default inference and recall limit: 10 seconds. A Host reuses a live isolated embedding subprocess, with at most 2 concurrent requests. Overload, cancellation, timeouts and cleanup failures are reported explicitly.
- The runtime is pinned to `@huggingface/transformers@3.8.1`. Models, `node_modules` and runtime caches are not committed.
- Whether a provider adapter enforces a token budget server-side is provider-dependent. A local budget intention is not a guaranteed server-side limit.

</details>

## Validation

| Validation type | Result | Interpretation |
| :--- | :--- | :--- |
| 0.1.16 public-source regression · Node | **184 / 184** | Historical result: synthetic sources and controlled LLMs; actual local embeddings / SDK |
| 0.1.16 public-source regression · Electron | **186 / 186** | Historical result: actual installed SDK; no failures, cancellations or skips |
| Fixed sample · Q13 | **First 5 / 5** | The specified local pre-publication evaluation |
| Fixed sample · 36 cases | **36 / 36 × 2 rounds** | No previously correct positive became empty; not a universal guarantee |

> The fixed-sample evaluation also used `deepseek-account/deepseek-flash`. Private raw data is not published. Controlled regression tests do not replace real semantic evaluation or establish reliability for every model and future request.
>
> Local recall p50 was approximately **1.43–1.45 seconds**, versus 1.18–1.23 seconds previously. The accuracy fix is not a performance-improvement claim.

<details>
<summary><strong>Reproduce public regression tests</strong></summary>

Install dependencies and models first, with `/Applications/DeepSeek Harness.app` and `/usr/local/bin/node` available. Tests use independent temporary SQLite databases, require no cloud account and do not modify production memories. Missing desktop SDKs or assets fail explicitly; they are not counted as passes.

```sh
NODE_OPTIONS='' /usr/local/bin/node --test --test-timeout=90000 test/*.test.mjs
ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS='' \
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --test --test-timeout=90000 test/*.test.mjs
for file in lib/*.js scripts/*.mjs; do /usr/local/bin/node --check "$file" || exit; done
```

Public fixtures are independent of private conversations. `evidence/` contains only an empty-directory placeholder; runtime outputs are ignored. The relevance rules are `jiyi-relevance-v7`; the extractor is v4.

</details>

## FAQ

**Does closing the sidebar stop the plugin?**<br/>
No. State polling pauses when the panel tab or document is hidden, but the Host continues. Disabling the plugin stops extraction and recall.

**Does the main model have to call a search tool?**<br/>
No. Automatic recall is the normal path; `jiyi_search` is an explicit supplementary entry point.

**How do updates, migrations and removal work?**<br/>
Back up the plugin and settings before updating. For a running SQLite database, use the backup API or a safe consistent backup. Do not assume a lossless migration from the old topics/inbox architecture merely because of the version number. Alias backfills use the [explicit migration script](<scripts/migrate-aliases.mjs>); inspect its plan and back up before applying it. Production memory is not silently rewritten.

To remove jiyi, drop it from desktop `package.json` `dependencies` and `dsh.profile.bundles`, delete the unused `node_modules/jiyi` link, and remove any desktop-patch config overlay for that id. Do not empty the whole patch. Then fully quit and reopen DSH. Retaining or deleting memory data is the user's choice.

## Community and license

This public DSH community plugin has a description and the `dsh-plugin` Topic. Directory inclusion still requires third-party review; it is not official endorsement or automatic official installation. No self-promotion PR is submitted automatically. Package, Host and Client bundle IDs are all `jiyi`; `private: true` prevents npm publication.

Source code is [MIT-licensed](<LICENSE>). The model is a separate Apache-2.0 asset; its source and pinned revision appear in the [manifest](<models/manifest.json>). Third-party dependencies retain their own licenses.

<div align="center"><sub>Remember facts. Respect boundaries. · <a href="README.md">阅读中文版 →</a></sub></div>
