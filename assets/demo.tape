# prevAIl — terminal cockpit demo
# Render with: vhs assets/demo.tape  →  assets/demo.gif
#
# Walks through: boot demo vault, navigate domains, cycle tabs, toggle
# council, cycle framework, open tools, quit. ~14s of GIF that shows the
# full cockpit vocabulary without depending on live council responses
# (those are unpredictable and would mistime the tape).

Output assets/demo.gif

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

# Land in chat on the first domain. Pause so the cockpit reads.
Sleep 1500ms

# Walk down through the sidebar to show the domain list.
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Up
Sleep 500ms
Up
Sleep 600ms

# Quit cleanly.
Type "q"
Sleep 800ms
