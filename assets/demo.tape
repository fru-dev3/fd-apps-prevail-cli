# prevAIl — terminal cockpit demo (main hero GIF)
# Render with: vhs assets/demo.tape  →  assets/demo.gif
#
# Storyboard (~20s):
#   1. Boot the demo vault — splash + cockpit appears
#   2. Tour the LIFE DOMAINS sidebar (20+ life areas)
#   3. Cycle the Framework chip a few times (BLUF → WIN → SCQA)
#   4. Cycle the Lens chip through multiple cognitive lenses
#   5. Toggle Council ON
#   6. Toggle Serendipity ON
#   7. Quit cleanly
#
# We're showing the COCKPIT vocabulary — the chips that drive every
# turn (council × framework × lens × web × save × serendipity × auto).
# No live AI calls; those take too long and are nondeterministic.

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

# Boot the cockpit. Wordmark + sidebar + active domain pane.
Sleep 3500ms

# Exit chat so arrow keys navigate the sidebar instead of going to
# the chat input's history recall.
Escape
Sleep 600ms

# Walk down the sidebar to show the 20+ LIFE DOMAINS.
Down
Sleep 400ms
Down
Sleep 400ms
Down
Sleep 400ms
Down
Sleep 400ms
Down
Sleep 700ms

# Walk back up to chief.
Up
Sleep 350ms
Up
Sleep 350ms
Up
Sleep 350ms
Up
Sleep 350ms
Up
Sleep 700ms

# Quit so the GIF ends cleanly. The viewer has now seen the wordmark,
# the sidebar of 20+ life domains, the active chief workspace with
# suggested prompts, and the ConfigBar at the bottom showing the
# whole chip stack (Council / Framework / Lens / Web / Save /
# Serendipity / Auto / vault / edit).
Type "q"
Sleep 800ms
