import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import type { TokenCredential } from "@azure/core-auth";

let credential: TokenCredential | undefined;

export function azureCredential(): TokenCredential {
  if (credential) return credential;
  credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID?.trim()
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID.trim())
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  return credential;
}
