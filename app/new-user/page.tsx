import prisma from "@/utils/db";
import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function connect() {
    const user = await currentUser();
    console.log(user)
    if (!user) {
        return redirect("/sign-in");

    }
    let userName;
    if (!user.username) {
        userName = `${user.firstName} ${user.lastName}`
    }
    else {
        userName = user.username
    }

    const match = await prisma.user.upsert({
        where: {
            clerkId: user.id as string,
        },
        update: {
            email: user.emailAddresses[0].emailAddress,
            name: userName,
        },
        create: {
            clerkId: user.id,
            email: user.emailAddresses[0].emailAddress,
            name: userName,
        },
    });


    redirect("/dashboard");
}
