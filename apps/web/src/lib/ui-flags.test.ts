// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  deploymentApps,
  deploymentSuppliesOAuthClient,
  offeredApps,
  parseDeploymentApps,
  sectionHidden,
} from "./ui-flags";

afterEach(() => {
  delete window.__BOTCAMP_UI__;
  delete window.__RAKAZO_UI__;
});

describe("parseDeploymentApps", () => {
  it("keeps an app that names a name, an https endpoint and its scope choices", () => {
    expect(
      parseDeploymentApps([
        {
          name: " Mail ",
          endpoint: "https://mail.example.test/mcp",
          scopes: [{ label: "Read", scope: "mail.read" }],
        },
      ]),
    ).toEqual([
      {
        name: "Mail",
        endpoint: "https://mail.example.test/mcp",
        scopes: [{ label: "Read", scope: "mail.read" }],
      },
    ]);
  });

  it("drops an app without a name or an https endpoint", () => {
    expect(
      parseDeploymentApps([
        { name: "", endpoint: "https://mail.example.test/mcp" },
        { name: "Plain", endpoint: "http://mail.example.test/mcp" },
        { name: "File", endpoint: "file:///tmp/mcp" },
        { name: "Missing", endpoint: "not a url" },
        { endpoint: "https://unnamed.example.test/mcp" },
        "mail",
      ]),
    ).toEqual([]);
  });

  it("keeps the scopes it can send and drops the rest", () => {
    const [app] = parseDeploymentApps([
      {
        name: "Mail",
        endpoint: "https://mail.example.test/mcp",
        scopes: [
          { label: "Read", scope: "mail.read mail.list" },
          { label: "", scope: "mail.send" },
          { label: "Send", scope: "mail.send\nmail.delete" },
          { label: "Broken", scope: 42 },
        ],
      },
    ]);
    expect(app?.scopes).toEqual([{ label: "Read", scope: "mail.read mail.list" }]);
  });

  it("asks for an OAuth client only when the deployment says the provider needs one", () => {
    const [app] = parseDeploymentApps([
      {
        name: "GitHub",
        endpoint: "https://api.githubcopilot.com/mcp",
        oauthClientRequired: true,
      },
    ]);
    expect(app?.oauthClientRequired).toBe(true);
    const [plain] = parseDeploymentApps([
      { name: "Notion", endpoint: "https://mcp.notion.com/mcp", oauthClientRequired: "yes" },
    ]);
    expect(plain?.oauthClientRequired).toBeUndefined();
  });

  it("takes no apps from anything but a list", () => {
    expect(parseDeploymentApps(undefined)).toEqual([]);
    expect(parseDeploymentApps({ name: "Mail" })).toEqual([]);
  });
});

describe("deploymentApps", () => {
  it("reads the apps a deployment sets in config.js", () => {
    window.__RAKAZO_UI__ = {
      apps: [{ name: "Mail", endpoint: "https://mail.example.test/mcp" }],
    };
    expect(deploymentApps()).toEqual([
      { name: "Mail", endpoint: "https://mail.example.test/mcp", scopes: [] },
    ]);
  });

  it("is empty when the deployment lists none, so the catalog shows", () => {
    expect(deploymentApps()).toEqual([]);
    window.__RAKAZO_UI__ = { hiddenSections: ["billing"] };
    expect(deploymentApps()).toEqual([]);
  });
});

describe("deploymentSuppliesOAuthClient", () => {
  it("is true only for an endpoint the deployment registered", () => {
    window.__BOTCAMP_UI__ = {
      oauthClients: ["https://api.githubcopilot.com/mcp", "not a url"],
    };
    expect(deploymentSuppliesOAuthClient("https://api.githubcopilot.com/mcp")).toBe(true);
    expect(deploymentSuppliesOAuthClient("https://mcp.notion.com/mcp")).toBe(false);
  });

  it("is false without the setting", () => {
    expect(deploymentSuppliesOAuthClient("https://api.githubcopilot.com/mcp")).toBe(false);
  });
});

describe("sectionHidden", () => {
  it("hides only the sections the deployment names", () => {
    window.__RAKAZO_UI__ = { hiddenSections: ["billing"] };
    expect(sectionHidden("billing")).toBe(true);
    expect(sectionHidden("models")).toBe(false);
  });

  it("keeps the legacy flags when the new object is empty", () => {
    window.__BOTCAMP_UI__ = {};
    window.__RAKAZO_UI__ = { hiddenSections: ["billing"] };
    expect(sectionHidden("billing")).toBe(true);
    window.__BOTCAMP_UI__ = { hiddenSections: ["models"] };
    expect(sectionHidden("models")).toBe(true);
    expect(sectionHidden("billing")).toBe(false);
  });
});

describe("offeredApps", () => {
  it("offers the app this build ships when the deployment names none", () => {
    expect(offeredApps()).toEqual([
      {
        name: "QQ邮箱",
        endpoint: "https://api.mail.qq.com/mcp",
        scopes: [
          { label: "只读", scope: "alias:read mail:read" },
          { label: "可发信", scope: "alias:read mail:read mail:send" },
        ],
      },
      {
        name: "Notion",
        endpoint: "https://mcp.notion.com/mcp",
        scopes: [],
      },
      {
        name: "GitHub",
        endpoint: "https://api.githubcopilot.com/mcp",
        scopes: [],
        oauthClientRequired: true,
      },
    ]);
  });

  it("lets a deployment replace the app this build ships", () => {
    window.__RAKAZO_UI__ = {
      apps: [{ name: "Inbox", endpoint: "https://mail.example.test/mcp" }],
    };
    expect(offeredApps()).toEqual([
      { name: "Inbox", endpoint: "https://mail.example.test/mcp", scopes: [] },
    ]);
  });
});
