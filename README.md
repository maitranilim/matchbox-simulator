# Matchbox Simulator 🔥

**Play it here: [matchbox-simulator.vercel.app](https://matchbox-simulator.vercel.app)**

I built this because I wanted to strike a match without actually burning my fingers. It started as a small matchbox-and-candle toy. It grew into a little fire lab where you can pull everyday things out of a cupboard and watch how each one reacts to an open flame.

## What you can do

- **Strike a match** on the side of the box and light the candle.
- **Open the cupboard** and drag out household items to see how they behave near fire:
  - newspaper and cardboard burn quickly
  - a cotton rag smoulders
  - pine kindling takes a while to catch
  - a plastic bottle melts first and then burns
  - steel wool glows, and gets *heavier* as it burns because it's picking up oxygen
  - spilled rubbing alcohol burns with a faint blue flame
  - a deodorant can bursts once it gets too hot
  - cooking oil on the stove ignites at around 300 °C, and throwing water on it causes a steam explosion (please never try this in a real kitchen)
  - baking soda smothers the flames
  - a handful of flour tossed into the air turns into a dust explosion
- **Throw things around.** Everything has a real mass in grams and falls under real gravity, and objects collide instead of passing through each other.

## Why I made it

I like building small interactive things, and fire felt like a good excuse to learn real-time physics and 3D in the browser. It's also a safe way to show why you shouldn't put water on an oil fire.

## Tech

- [Three.js](https://threejs.org/) for rendering
- [Rapier](https://rapier.rs/) for rigid-body physics (1 unit = 1 cm, masses in grams)
- [Vite](https://vitejs.dev/) for dev and build
- Hosted on [Vercel](https://vercel.com/)

## Running it locally

You'll need Node 20 or newer.

```bash
git clone https://github.com/maitranilim/matchbox-simulator.git
cd matchbox-simulator
npm install
npm run dev
```

To make a production build, run `npm run build`. The output goes to `dist/`.

## A word on safety

This is a simulation. The chemistry is simplified to make it fun and roughly believable, and it isn't a safety guide. Please don't recreate any of it at home.

## Author

Made by **Nishan** ([@maitranilim](https://github.com/maitranilim)).
