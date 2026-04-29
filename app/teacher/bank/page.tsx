import { redirect } from "next/navigation";

// The dedicated "Question Bank" surface has been folded into the Quiz Composer
// at /teacher/quizzes/new — that page lets you browse, search, filter, delete,
// and pick questions all in one place. We redirect any old links here.
export default function BankRedirect() {
  redirect("/teacher/quizzes/new");
}
