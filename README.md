# CS 448B Assignment 3: Santa Clara County Restaurant Finder

Interactive dynamic-queries map of Santa Clara County restaurants, built with D3 v7 and vanilla JavaScript.

- **Live version:** https://elasigin.github.io/cs448b-hw3/
- **Source:** https://github.com/elasigin/cs448b-hw3

## How to run
- Open the live link in Google Chrome. Nothing to install.
- To run locally:
  1. Download or unzip the code.
  2. In a terminal, `cd` into the folder and run `python3 -m http.server`.
  3. Open http://localhost:8000 in Chrome.
- A local server is needed because Chrome blocks loading the CSV from `file://`.
- Needs an internet connection, since D3 v7 loads from a CDN.

## How to use
- Drag circles **A** and **B** to move them; set their radii with the sliders.
- Only restaurants inside both circles that pass every filter are colored; the rest are gray.
- Filters: minimum rating, minimum number of reviews (log scale), keyword search on name and address (comma-separated terms match any), and placard color.
- Hover a point for details. **Reset** restores the defaults.

## Files
- `index.html`: the page
- `style.css`: styling
- `main.js`: all the logic, built by `createApp()`
- `data/`: the restaurant CSV and the basemap PNG
