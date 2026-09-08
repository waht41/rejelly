const changelog = {
  getReleaseLine(changeset) {
    const [firstLine, ...remainingLines] = changeset.summary
      .split("\n")
      .map((line) => line.trimEnd());
    let output = `- ${firstLine}`;
    if (remainingLines.length > 0) {
      output += `\n${remainingLines.map((line) => `  ${line}`).join("\n")}`;
    }
    return output;
  },

  getDependencyReleaseLine(_changesets, dependenciesUpdated) {
    if (dependenciesUpdated.length === 0) return "";
    return [
      "- Updated dependencies:",
      ...dependenciesUpdated.map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`),
    ].join("\n");
  },
};

export default changelog;
