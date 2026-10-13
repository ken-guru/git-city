# Glossary

**GitCity**: The product: a CLI that turns a repo's git history into an animated 3D city, published as a static webpage.

**City**: The whole visualization of one repo at one point on the Timeline.

**Building**: One file in the repo. It grows and shrinks as the file does.

**Lot**: The fixed patch of ground a Building occupies for as long as its file stays in one directory. It is sized for the widest the Building gets there, with room for one more step, and stays empty before the Building is built and after it is demolished or relocated. A Lot is never reused.

**Relocation**: A Building whose file moved to another directory. It is taken down on its old Lot and rebuilt on a new one, and stays the same Building, with the same look, name and age. A whole directory moving together is not a Relocation: its street is renamed in place.

**Renovation**: A Building whose Building type changes. It is taken down and rebuilt as the new type on the same Lot.

**Category**: What kind of file a Building represents: source code, tests, docs, config, build/CI, data, assets, generated/vendored, or unknown. It is detected from the path and can be overridden by the user.

**Building type**: The basic shape a Building takes because of its Category, for example an office tower for source code or a library for docs.

**Floor**: One storey of a Building. Height is counted in Floors, and construction and deconstruction add or remove them one at a time.

**Module**: An internal grouping of the repo's own code, never anything outside the repo. A directory below the root with a package manifest is a Module; any file not under one belongs to its top-level directory's Module. A manifest in the root directory never makes the whole repo one Module. A directory becomes or stops being a Module when its manifest is added or removed.

**District**: A Module drawn as a village of Blocks, coloured by its Role, set apart from the others on the Countryside. A Module that appears partway through history becomes a village of its own only if it already existed when its first files arrived; otherwise it splits off in place inside the village it grew up in, and merges back the same way. No Building moves either way.

**Neighbourhood**: A subdirectory of a Module, drawn as the Blocks it owns inside its District and named like a street ("Mill Lane"). There is only one level: anything deeper belongs to its nearest Neighbourhood.

**Block**: A small group of Lots ringed by streets and owned by one Neighbourhood. A District grows by adding Blocks as close to its centre as it can, and a Block never moves.

**Countryside**: The open land between Districts. Roads and Highways cross it; its fields, forests, hills, mountains and rivers are scenery only and never stand for anything in the repo.

**Road**: A connection between code inside the City, made when one file in the repo references another. Between Districts, Roads form one shared network across the Countryside: each connection travels the shortest way along it, so a Road carries every connection that passes over it. Inside a District, connections run along its Block streets.

**Lane**: One unit of a Road's capacity in one direction. Every Road has at least one Lane each way; a stronger connection adds Lanes, and a Road can have more Lanes one way than the other when the dependency mostly runs one way. A Road that no connection uses is an unpaved track.

**External Dependency**: A package from outside the repo that a Module's manifest declares as a direct dependency, including development-only ones. It is never a Module. Packages that are only pulled in transitively, or imported without being declared, are not External Dependencies.

**External City**: A group of External Dependencies sharing a scope or name prefix (for example everything under `@babel`), large enough to stand on its own, drawn on the horizon beyond the Countryside.

**Outskirts**: A single External City that holds every External Dependency whose group is too small to get its own.

**Highway**: A connection from a District towards an External City. Highways leave each District for an orbital motorway that rings the Countryside, and spurs lead from it to the External Cities. It is distinct from a Road, which never leaves the City.

**Timeline**: The ordered sequence of commits that the City animates through and that the viewer can scrub.

**Contributor**: A person who authored commits. Contributors are absent from the City unless the user opts in, and then they appear under a Real name or a Pseudonym.

**Automation**: Every bot that authored commits (release, dependency and CI bots), shown together as a single Contributor.

**Real name**: The actual name of a file, Module or concept as it appears in the repo.

**Pseudonym**: A replacement name the user chooses explicitly for a specific file, Module or concept.

**Generated name**: A name GitCity makes up automatically from the City's Theme. Unlike a Pseudonym, the user doesn't choose it. A District's Generated name combines a proper name with its Role's noun ("Ashford Keep"); External Cities and the City itself get a proper name only.

**Theme**: The naming and colour style for a whole City, such as modern or medieval. It supplies the word pieces for place, street and person names and a noun for every Role, and may supply a palette with a hue for every Role.

**Role**: What a Module is for (auth, tests, docs, API, UI, data…), detected from its path and the mix of Categories inside it. A Theme turns a Role into a noun, for example docs → "Archive", and its palette turns a Role into a hue, so Districts with the same Role share a hue.

**Label**: The fallback display for something with no Pseudonym, Generated name or revealed Real name. It is the thing's type plus its birth-order number, for example "TypeScript file 412". It identifies nothing outside the City.

**Reveal**: The user's explicit opt-in to show Real names, either globally or for specific things. Nothing is revealed by default.

**Concept**: A word that can appear inside many names (for example a company or product name). A Pseudonym for a Concept replaces it everywhere it appears.

_Displayed names follow this precedence:_ Pseudonym, then Real name (only when revealed), then Generated name, then Label. When a Module's Real name is shown, its Generated name can still appear as a subtitle.
