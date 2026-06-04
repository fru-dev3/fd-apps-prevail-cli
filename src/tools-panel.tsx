import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme.ts";
import { readTelegramConfig, telegramConfigFile } from "./telegram-config.ts";
import { openInFinder } from "./system.ts";

interface Props {
  onClose: () => void;
}

// Single overlay where everything prevAIl ships but doesn't otherwise
// surface gets a row. User said "you built a lot of stuff and i can't
// even see them" — this is the answer. Read-only status + the exact
// command or shell snippet to make each integration go. Press Escape or
// click ✕ to close.
export function ToolsPanel({ onClose }: Props) {
  useKeyboard((evt) => {
    if (evt.name === "escape") onClose();
  });

  const tg = readTelegramConfig();
  const tgConfigured = Boolean(tg?.botToken);
  const tgAllowCount = tg?.allowList.length ?? 0;
  const tgConfigPath = telegramConfigFile();

  const binPath = process.execPath;
  const mcpCmd = `${binPath} mcp`;

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.aiAccent}
      backgroundColor={theme.bg}
      title=" Tools & Integrations "
      titleAlignment="left"
      bottomTitle=" Esc to close "
      bottomTitleAlignment="right"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <scrollbox flexGrow={1} scrollY>
        {/* MCP — the big one. prevail BECOMES a tool that other agents
            (Claude Desktop, Cursor, Continue, Goose) can call. */}
        <Section
          glyph="◆"
          title="MCP server — use prevAIl in other apps"
          status="ready to wire"
          statusFg={theme.ok}
        >
          <text fg={theme.fg}>
            prevAIl can be plugged into Claude Desktop, Cursor, Continue,
            Goose, or any host that speaks MCP. Exposes 5 tools: council,
            chat, list_domains, read_state, read_log.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>Add to ~/Library/Application Support/Claude/claude_desktop_config.json:</text>
          <box
            paddingLeft={1}
            paddingRight={1}
            border
            borderColor={theme.border}
            flexDirection="column"
          >
            <text fg={theme.aiAccent}>{`{`}</text>
            <text fg={theme.aiAccent}>{`  "mcpServers": {`}</text>
            <text fg={theme.aiAccent}>{`    "prevail": {`}</text>
            <text fg={theme.aiAccent}>{`      "command": "${binPath}",`}</text>
            <text fg={theme.aiAccent}>{`      "args": ["mcp"]`}</text>
            <text fg={theme.aiAccent}>{`    }`}</text>
            <text fg={theme.aiAccent}>{`  }`}</text>
            <text fg={theme.aiAccent}>{`}`}</text>
          </box>
          <text fg={theme.fgFaint}>{`  CLI to run manually: ${mcpCmd}`}</text>
        </Section>

        {/* Telegram bridge */}
        <Section
          glyph="◆"
          title="Telegram bridge"
          status={tgConfigured ? `configured (${tgAllowCount} allowed)` : "not configured"}
          statusFg={tgConfigured ? theme.ok : theme.fgDim}
        >
          <text fg={theme.fg}>
            Run prevAIl on your phone. Daemon long-polls Telegram; you
            chat from anywhere with the same engines + council + vault.
          </text>
          <text> </text>
          {!tgConfigured ? (
            <>
              <text fg={theme.fgDim}>1. Message @BotFather on Telegram, send /newbot, get a token</text>
              <text fg={theme.fgDim}>2. In chat: <span fg={theme.aiAccent}>{`/telegram setup <bot-token>`}</span></text>
              <text fg={theme.fgDim}>3. Message your bot once, grab your chat-id from the daemon log</text>
              <text fg={theme.fgDim}>4. In chat: <span fg={theme.aiAccent}>{`/telegram add <chat-id>`}</span></text>
              <text fg={theme.fgDim}>5. Run the daemon: <span fg={theme.aiAccent}>{`prevail daemon --telegram`}</span></text>
            </>
          ) : (
            <>
              <text fg={theme.fgDim}>{`  config:  ${tgConfigPath}`}</text>
              <text fg={theme.fgDim}>{`  allow:   ${tgAllowCount} chat ID(s)`}</text>
              <text fg={theme.fgDim}>Run the daemon: <span fg={theme.aiAccent}>{`prevail daemon --telegram`}</span></text>
            </>
          )}
        </Section>

        {/* Briefings */}
        <Section
          glyph="◆"
          title="Scheduled briefings"
          status="cron-driven"
          statusFg={theme.fgDim}
        >
          <text fg={theme.fg}>
            Domain-scoped prompts on a schedule. At 7am the panel debates;
            at 7:01 the verdict lands in your phone.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>List: <span fg={theme.aiAccent}>/briefing list</span></text>
          <text fg={theme.fgDim}>{`Add:  /briefing add "0 7 * * *" wealth "what's new this week?" council both`}</text>
          <text fg={theme.fgDim}>Run a briefing now: <span fg={theme.aiAccent}>/briefing run &lt;id&gt;</span></text>
          <text fg={theme.fgDim}>Stored at: <span fg={theme.fgFaint}>{`<vault>/.briefings.json`}</span></text>
        </Section>

        {/* Calibration */}
        <Section
          glyph="◆"
          title="Calibration — council vs yourself"
          status="learning-by-doing"
          statusFg={theme.fgDim}
        >
          <text fg={theme.fg}>
            Record your gut take BEFORE the council fires. 90 days
            later, prevAIl asks how it actually went. Builds a
            scoreboard of when your gut beats the council and when
            it doesn't.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>{`Before a council turn: `}<span fg={theme.aiAccent}>{`/gut <one-line take>`}</span></text>
          <text fg={theme.fgDim}>Pending retros: <span fg={theme.aiAccent}>/calibration pending</span></text>
          <text fg={theme.fgDim}>Score so far: <span fg={theme.aiAccent}>/calibration status</span></text>
        </Section>

        {/* Benchmarks */}
        <Section
          glyph="◆"
          title="prevail-bench"
          status="public benchmark suite"
          statusFg={theme.fgDim}
        >
          <text fg={theme.fg}>
            Run the council against a curated set of decision-grade
            questions. Compare model variants. Track regression over
            time. Results are markdown — PR-able.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>List the suite: <span fg={theme.aiAccent}>{`prevail bench list`}</span></text>
          <text fg={theme.fgDim}>Run all: <span fg={theme.aiAccent}>{`prevail bench run`}</span></text>
          <text fg={theme.fgDim}>Just one: <span fg={theme.aiAccent}>{`prevail bench run --question <id>`}</span></text>
          <text fg={theme.fgDim}>Results: <span fg={theme.fgFaint}>~/.prevail/bench-results/&lt;date&gt;/</span></text>
        </Section>

        {/* Connectors / OAuth */}
        <Section
          glyph="◆"
          title="Connectors — apps + OAuth flows"
          status="click Apps in sidebar to see all"
          statusFg={theme.fgDim}
        >
          <text fg={theme.fg}>
            Every app in the sidebar (Plaid, GitHub, YouTube Analytics,
            LinkedIn, Google Calendar, AppFolio, ...) has its own
            workspace: Auth status, scheduled syncs, runnable skills,
            data files.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>OAuth flow (Google, GitHub, etc): <span fg={theme.aiAccent}>{`prevail connectors oauth <id>`}</span></text>
          <text fg={theme.fgDim}>Probe auth status: <span fg={theme.aiAccent}>{`prevail connectors test <id>`}</span></text>
          <text fg={theme.fgDim}>Run a skill from CLI: <span fg={theme.aiAccent}>{`prevail connectors run <id> <skill>`}</span></text>
        </Section>

        {/* Web access */}
        <Section
          glyph="◆"
          title="Web access (global gate)"
          status="see /web in chat"
          statusFg={theme.fgDim}
        >
          <text fg={theme.fg}>
            Globally allow / deny WebSearch + WebFetch for every CLI
            engine. Useful when you want a vault-only conversation.
          </text>
          <text> </text>
          <text fg={theme.fgDim}>Status: <span fg={theme.aiAccent}>/web</span></text>
          <text fg={theme.fgDim}>Toggle: <span fg={theme.aiAccent}>/web off</span> / <span fg={theme.aiAccent}>/web on</span></text>
        </Section>

        {/* Vault links */}
        <Section
          glyph="◆"
          title="Vault + config locations"
          status="filesystem"
          statusFg={theme.fgDim}
        >
          <Link path={join(homedir(), ".prevail")} label="~/.prevail/" />
          <Link path={join(homedir(), ".prevail", "config.json")} label="~/.prevail/config.json — vault path + framework + council default" />
          <Link path={tgConfigPath} label="~/.prevail/telegram.json — bot token + allow-list (chmod 0600)" />
          <Link path={join(homedir(), ".prevail", "connectors")} label="~/.prevail/connectors/ — per-app auth + data" />
          <Link path={join(homedir(), ".prevail", "bench-results")} label="~/.prevail/bench-results/ — bench output" />
        </Section>
      </scrollbox>
    </box>
  );
}

function Section({
  glyph,
  title,
  status,
  statusFg,
  children,
}: {
  glyph: string;
  title: string;
  status: string;
  statusFg: string;
  children?: React.ReactNode;
}) {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" height={1}>
        <text fg={theme.gold} attributes={1}>{`${glyph}  ${title}`}</text>
        <text fg={theme.fgFaint}>{"   ·   "}</text>
        <text fg={statusFg}>{status}</text>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        {children}
      </box>
      <text> </text>
    </box>
  );
}

function Link({ path, label }: { path: string; label: string }) {
  const present = existsSync(path);
  return (
    <box flexDirection="row" height={1} onMouseDown={() => openInFinder(path)}>
      <text fg={present ? theme.aiAccent : theme.fgDim}>{present ? "→ " : "× "}</text>
      <text fg={present ? theme.fg : theme.fgFaint}>{label}</text>
    </box>
  );
}
