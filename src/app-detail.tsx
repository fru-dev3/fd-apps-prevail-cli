import { theme } from "./theme.ts";
import { readAppSkill, type AppSkill } from "./vault.ts";
import { renderMarkdownLines } from "./markdown-lite.tsx";

interface Props {
  app: AppSkill;
}

export function AppDetail({ app }: Props) {
  const content = readAppSkill(app);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.borderFocus}
      backgroundColor={theme.bg}
      title={` app: ${app.id} `}
      titleAlignment="left"
      bottomTitle={` used in ${app.domains.length} domain${app.domains.length === 1 ? "" : "s"}: ${app.domains.join(", ")} `}
      bottomTitleAlignment="left"
    >
      <box
        flexDirection="row"
        height={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.bg}
      >
        <text fg={theme.gold}>{app.title}</text>
        <text fg={theme.fgFaint}>  ·  c chat / use this app</text>
      </box>
      <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <scrollbox flexGrow={1} scrollY>
          {renderMarkdownLines(content)}
        </scrollbox>
      </box>
    </box>
  );
}
