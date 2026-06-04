# prevAIl — terminal cockpit demo
# Render with: vhs assets/demo.tape  →  assets/demo.gif
#
# Requires vhs (brew install vhs). The tape boots the demo vault, walks
# through the council flow, switches domains, opens the tools panel, and
# fires a /council question. Aim is ~12s of GIF showing the cockpit
# vocabulary: sidebar nav · tabs · council ON · framework cycle · chat.

Output assets/demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1280
Set Height 760
Set Theme { "name": "prevAIl", "background": "#0E0E0E", "foreground": "#E6D9B8", "cursor": "#C4A35A", "selection": "#3a2f1a", "black": "#0E0E0E", "red": "#E67E5F", "green": "#7FCB8C", "yellow": "#C4A35A", "blue": "#3CD8FF", "magenta": "#D49FFF", "cyan": "#3CD8FF", "white": "#E6D9B8", "brightBlack": "#5C5346", "brightRed": "#F5A98D", "brightGreen": "#A8E5B0", "brightYellow": "#F5E0A8", "brightBlue": "#9FECFF", "brightMagenta": "#E5C3FF", "brightCyan": "#9FECFF", "brightWhite": "#FFFFFF" }
Set Padding 24
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

Hide
Type "clear"
Enter
Show

Type "prevail demo"
Sleep 400ms
Enter
Sleep 2500ms

# Land in chat for the first domain. Show the workspace + ▸ Chat link.
Sleep 1200ms

# Ask a council question.
Type "/council should I prepay the mortgage or invest the cash?"
Sleep 400ms
Enter
Sleep 4000ms

# Switch to a different domain via the sidebar.
Down
Sleep 350ms
Down
Sleep 350ms

# Toggle a framework.
Sleep 600ms
Type "/framework bluf"
Enter
Sleep 1500ms

# Cycle into apps with the swap key, then back.
Type "s"
Sleep 1200ms
Type "s"
Sleep 1200ms

# Quit cleanly.
Type "q"
Sleep 800ms
