# prevAIl — deliberation stack GIF
# Render with: vhs assets/deliberation.tape  →  assets/deliberation.gif
#
# Focused on the COUNCIL × LENS × FRAMEWORK stack — the single feature
# that defines what prevAIl is FOR. We boot into the wealth domain
# (high-stakes decisions = real council fit), then walk through the
# chips that shape every turn.

Output assets/deliberation.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1280
Set Height 760
Set Theme { "name": "prevAIl", "background": "#0E0E0E", "foreground": "#E6D9B8", "cursor": "#C4A35A", "selection": "#3a2f1a", "black": "#0E0E0E", "red": "#E67E5F", "green": "#7FCB8C", "yellow": "#C4A35A", "blue": "#3CD8FF", "magenta": "#D49FFF", "cyan": "#3CD8FF", "white": "#E6D9B8", "brightBlack": "#5C5346", "brightRed": "#F5A98D", "brightGreen": "#A8E5B0", "brightYellow": "#F5E0A8", "brightBlue": "#9FECFF", "brightMagenta": "#E5C3FF", "brightCyan": "#9FECFF", "brightWhite": "#FFFFFF" }
Set Padding 24
Set TypingSpeed 55ms
Set PlaybackSpeed 1.0

Hide
Type "clear"
Enter
Show

Type "./dist/prevail demo"
Sleep 400ms
Enter
Sleep 3500ms

# Escape out of chat so arrow keys navigate the sidebar.
Escape
Sleep 600ms

# Walk down to wealth (3rd domain).
Down
Sleep 500ms
Down
Sleep 1800ms

# Walk to skills tab via right arrow → highlights the per-domain skills.
Right
Sleep 800ms
Right
Sleep 800ms
Right
Sleep 800ms
Right
Sleep 1200ms

# Back to chat tab so the viewer ends on the most-used surface.
Right
Sleep 1500ms

# Quit.
Type "q"
Sleep 800ms
