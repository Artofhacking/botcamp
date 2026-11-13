// Deployment-time configuration. Leave empty to talk to the origin that served this page.
// A separate API host is set here, without rebuilding the app.
window.__BOTCAMP_API_ORIGIN__ = "";
// The operator console is a separate page; it reads the same value.
window.__BOTCAMP_ADMIN_API__ = "";
// What this deployment offers, without a rebuild.
// `__RAKAZO_API_ORIGIN__`, `__RAKAZO_ADMIN_API__`, and `__RAKAZO_UI__` still apply
// when the matching `__BOTCAMP_*` value is empty.
//
//   window.__BOTCAMP_UI__ = {
//     hiddenSections: ["models", "computer", "billing"],
//     // Listing apps here makes Integrations show only them: connect, or disconnect.
//     apps: [
//       {
//         name: "Mail",
//         endpoint: "https://mail.example.com/mcp",
//         // oauthClientRequired: true,
//         scopes: [
//           { label: "Read only", scope: "mail.read" },
//           { label: "Read and send", scope: "mail.read mail.send" },
//         ],
//       },
//     ],
//   };
