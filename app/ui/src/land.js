// The open conversation has to be one the roster actually indexes. A leftover
// id (the company placeholder, or a session the kernel never returned) is what
// makes the details pane say the chat is not part of the team.
export function landingSession(roster, shownId) {
  if (roster?.byId?.[shownId] || roster?.roomsById?.[shownId]) return shownId
  const bots = Array.isArray(roster?.bots) ? roster.bots : []
  const chief = bots.find((bot) => bot?.name === '主编' || bot?.name === '总负责人' || bot?.id === 'co_chief') || bots[0]
  return chief?.sessionId || chief?.id || shownId
}
