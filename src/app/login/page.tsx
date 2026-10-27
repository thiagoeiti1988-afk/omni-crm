import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { getStore } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/http";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar · Omni-CRM" };

export default async function LoginPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && getStore().sessionAuth(token)) redirect("/");
  return <LoginForm demo={process.env.OMNI_SEED_DEMO !== "0" && !process.env.OMNI_DEMO_PASSWORD} />;
}
