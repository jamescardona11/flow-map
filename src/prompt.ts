import { createInterface } from "node:readline/promises";

export type Prompt = {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  input(question: string, defaultValue: string): Promise<string>;
};

async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await lines.question(question)).trim();
  } finally {
    lines.close();
  }
}

/** Questions on the terminal; an empty answer takes the default. */
export const terminalPrompt: Prompt = {
  async confirm(question, defaultYes) {
    for (;;) {
      const answer = (await ask(`${question} [${defaultYes ? "Y/n" : "y/N"}] `)).toLowerCase();
      if (answer === "") return defaultYes;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  },
  async input(question, defaultValue) {
    const answer = await ask(defaultValue === "" ? `${question}: ` : `${question} [${defaultValue}]: `);
    return answer === "" ? defaultValue : answer;
  },
};
