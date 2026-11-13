import { isOllamaCloudBaseUrl } from "@botcamp/contracts";
import { Disclosure } from "@botcamp/ui-web";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

export function CompatibleKeyField({
  baseUrl,
  className,
  children,
}: {
  baseUrl: string;
  className?: string;
  children: ReactNode;
}) {
  return isOllamaCloudBaseUrl(baseUrl) ? (
    <div className={className}>
      <span>
        <Trans>API key</Trans>
      </span>
      {children}
    </div>
  ) : (
    <Disclosure className={className} summary={<Trans>API key</Trans>}>
      {children}
    </Disclosure>
  );
}
