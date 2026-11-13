/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@botcamp/adapter-kit";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to BotCamp"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Thanks for signing up for BotCamp.")}</Text>
      <Text>
        {say("Want to run it on your own servers?")}{" "}
        <Link
          href="https://github.com/Artofhacking/botcamp/blob/main/docs/self-host.md"
          style={linkStyle}
        >
          {say("Self-host BotCamp")}
        </Link>
        .
      </Text>
      <Text>{say("Have any questions? Reply to this email.")}</Text>
      <Text>The BotCamp team</Text>
    </>,
    unsubscribeUrl,
  );
}
