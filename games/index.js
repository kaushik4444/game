'use strict';
// Game registry. To add a game: create games/<id>/index.js (see games/README.md) and list it here.
const registry = {
  wizard: require('./wizard'),
  twentynine: require('./twentynine'),
  poker: require('./poker'),
  themind: require('./themind'),
};

module.exports = {
  get: (id) => (typeof id === 'string' && Object.hasOwn(registry, id) ? registry[id] : null),
  list: () =>
    Object.values(registry).map(({ id, name, tagline, icon, accent, seats, options, rules }) => ({
      id,
      name,
      tagline,
      icon,
      accent,
      seats,
      options,
      rules,
    })),
};
