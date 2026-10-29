'use strict';
// Options shared by every game.

/** Per-turn time limit. When it runs out a bot plays for the player. */
const TIME_LIMIT_OPTION = {
  key: 'timeLimit',
  type: 'select',
  label: 'Turn time limit',
  default: '60',
  noRules: true,
  choices: [
    { value: 'off', label: 'No limit (auto play off)', desc: 'Players can take as long as they like. A bot only plays for someone who has disconnected.' },
    { value: '20', label: '20 seconds', desc: 'Fast game. If the time runs out a bot plays for you.' },
    { value: '30', label: '30 seconds', desc: 'If the time runs out a bot plays for you.' },
    { value: '45', label: '45 seconds', desc: 'If the time runs out a bot plays for you.' },
    { value: '60', label: '60 seconds', desc: 'If the time runs out a bot plays for you.' },
    { value: '90', label: '90 seconds', desc: 'If the time runs out a bot plays for you.' },
    { value: '120', label: '2 minutes', desc: 'Relaxed. If the time runs out a bot plays for you.' },
  ],
};

module.exports = { TIME_LIMIT_OPTION };
