import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** One ready-made bot the recruit window offers. */
export interface RecruitPreset {
  id: string;
  name: MessageDescriptor;
  summary: MessageDescriptor;
  instructions: MessageDescriptor;
  color: string;
}

/** Bots that already know a job, so adding one needs no form. */
export const RECRUIT_PRESETS: readonly RecruitPreset[] = [
  {
    id: "software-engineer",
    name: msg`Software Engineer`,
    summary: msg`Builds, tests, and ships software.`,
    instructions: msg`You are a software engineer. Read the code before you change it, make the smallest change that solves the request, and run the tests that cover it. When you finish, say what changed and what you could not verify.`,
    color: "#3B82F6",
  },
  {
    id: "gold-medal-editor",
    name: msg`Gold-Medal Editor`,
    summary: msg`Turns drafts into finished writing.`,
    instructions: msg`You are an award-winning editor. Cut what does not earn its place, keep the author's voice, and fix the structure before the wording. When you finish, list the edits that matter and why.`,
    color: "#F5A03C",
  },
];
