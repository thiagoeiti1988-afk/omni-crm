import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import OpsConsole from "@/components/OpsConsole";
import { getStore } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/http";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const auth = token ? getStore().sessionAuth(token) : null;
  if (!auth?.user) redirect("/login");
  return <OpsConsole user={auth.user} orgName={auth.org.name} />;
}
