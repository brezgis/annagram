# annagram

A tiny character-level language model of me, trained on my own writing and running entirely in
the browser. Live at <https://gram.brezgis.com>.

A pixel version of me talks one letter at a time. Faint letters are guesses, dark ones come from a
longer stretch of my writing, and pink ones are things I type all the time. Press space, click
`[rand]`, or poke the portrait to make me talk; type in `[given]:` and I'll continue your words.

## How it works

An interpolated Kneser–Ney n-gram model over characters (order 10, so it conditions on the last
9 characters), trained on about 37,000 words of my messages to coding agents, my notes, and my
blog posts. To pick each letter it counts what I've typed after the current 9-character context,
backing off to shorter contexts and blending the counts so it never runs out of options.

The training text itself isn't published, only the model. Before training, names, links, and
anything personal were scrubbed (the black bars are what got redacted), and long sequences I only
wrote once were pruned. The page also refuses to quote me eight words in a row; it checks against
hashes of my 8-word phrases in `models/novelty.json`, not the phrases themselves.

## Files

- `index.html`, `style.css`, `app.js`: the page, the puppet, and the shimmering title
- `engine.js`: Kneser–Ney sampling, the novelty guard (no DOM; runs in Node too)
- `models/char.json`: the trained model (n-gram counts per context)
- `assets/`: the pixel portrait, logo, and favicons

No build step. Serve the folder with any static server, e.g. `python3 -m http.server`.
