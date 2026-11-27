import { redirect } from "next/navigation";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const user = await getCurrentUser();
  if (user) {
    const [{ org }, isSuperAdmin] = await Promise.all([
      getCurrentOrgResult(),
      isUserInSuperAdminsTable(user.id),
    ]);
    if (!isSuperAdmin && (!org || org.status !== "active")) {
      redirect("/pending");
    }
    const safeDest =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/dashboard";
    redirect(safeDest);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-xl font-bold text-white shadow-md">
            🔒
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Sign in to cert-saas</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage your organization&apos;s events and certificates
          </p>
        </header>

        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <LoginForm nextUrl={next} initialError={error} />
        </section>
      </div>
    </main>
  );
}
