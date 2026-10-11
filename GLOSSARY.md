# Glossary

**GitCity**: The product: a CLI that turns a repo's git history into an animated 3D city, published as a static webpage.

**City**: The whole visualization of one repo at one point on the Timeline.

**Building**: One file in the repo. It grows and shrinks as the file does.

**Lot**: The fixed patch of ground a Building occupies for its whole life. It is sized for the largest the Building ever gets, and stays empty before the Building is built and after it is demolished. A Lot is never reused.

**Category**: What kind of file a Building represents: source code, tests, docs, config, build/CI, data, assets, generated/vendored, or unknown. It is detected from the path and can be overridden by the user.

**Building type**: The basic shape a Building takes because of its Category, for example an office tower for source code or a library for docs.

**Floor**: One storey of a Building. Height is counted in Floors, and construction and deconstruction add or remove them one at a time.

**Module**: An internal grouping of the repo's own code, never anything outside the repo. A directory with a package manifest is a Module; where there are no manifests, each top-level directory is one.

**District**: A Module drawn as a colour-coded area that contains its Buildings.

**Neighbourhood**: A subdirectory of a Module, drawn as an area inside its District. There is only one level: anything deeper belongs to its nearest Neighbourhood.

**Road**: A connection between code inside the City, made when one file in the repo references another. A Road between Districts bundles every file-to-file connection crossing between them.

**Lane**: One unit of a Road's capacity in one direction. A stronger connection has more Lanes, and a Road can have more Lanes one way than the other when the dependency mostly runs one way.

**External Dependency**: A package from outside the repo that a Module's manifest declares as a direct dependency. It is never a Module. Packages that are only pulled in transitively, or imported without being declared, are not External Dependencies.

**External City**: An External Dependency, or a group of them sharing a name prefix (for example everything under `react`), drawn on the horizon outside the city limits.

**Outskirts**: A single External City that holds every External Dependency too minor to get its own.

**Highway**: A connection leaving the city limits towards an External City. It is distinct from a Road, which never leaves the City.

**Timeline**: The ordered sequence of commits that the City animates through and that the viewer can scrub.

**Contributor**: A person who authored commits. Contributors are absent from the City unless the user opts in, and then they appear under a Real name or a Pseudonym.

**Real name**: The actual name of a file, Module or concept as it appears in the repo.

**Pseudonym**: A replacement name the user chooses explicitly for a specific file, Module or concept.

**Generated name**: A name GitCity makes up automatically, for example for a Module from its role or Real name, or a plausible city name for a hidden External City. Unlike a Pseudonym, the user doesn't choose it.

**Label**: The fallback display for something with no Pseudonym, Generated name or revealed Real name. It is the thing's type plus its birth-order number, for example "TypeScript file 412". It identifies nothing outside the City.

**Reveal**: The user's explicit opt-in to show Real names, either globally or for specific things. Nothing is revealed by default.

**Concept**: A word that can appear inside many names (for example a company or product name). A Pseudonym for a Concept replaces it everywhere it appears.

_Displayed names follow this precedence:_ Pseudonym, then Real name (only when revealed), then Generated name, then Label. When a Module's Real name is shown, its Generated name can still appear as a subtitle.
