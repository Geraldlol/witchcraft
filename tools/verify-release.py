"""Build and verify the addon ZIP using only files committed in the specified Git tree."""

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def git(*args):
    return subprocess.check_output(["git", *args])


def addon_files(commit):
    files = {}
    folded = set()
    listing = git("ls-tree", "-rz", "--full-tree", commit, "--", "Witchcraft")
    for row in listing.split(b"\0"):
        if not row:
            continue
        metadata, raw_name = row.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        name = raw_name.decode("utf-8")
        if mode not in (b"100644", b"100755") or kind != b"blob":
            raise ValueError(f"Expected a regular addon file: {name}")
        if "\\" in name or name.casefold() in folded:
            raise ValueError(f"Ambiguous addon path: {name}")
        folded.add(name.casefold())
        files[name] = git("cat-file", "blob", oid.decode("ascii"))
    return files


def validate_load_paths(files):
    toc = "Witchcraft/Witchcraft.toc"
    bindings = "Witchcraft/Bindings.xml"  # Loaded by WoW without an explicit TOC line.
    pending = [bindings]
    visited = set()

    def reference(parent, value):
        child = posixpath.normpath(posixpath.join(posixpath.dirname(parent), value.replace("\\", "/")))
        if child not in files:
            raise ValueError(f"{parent} refers to missing or incorrectly cased file {child}")
        if child.lower().endswith(".xml"):
            pending.append(child)

    for line in files[toc].decode("utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            reference(toc, line)
    while pending:
        name = pending.pop()
        if name in visited:
            continue
        visited.add(name)
        root = ET.fromstring(files[name])
        if name == bindings and root.tag.rsplit("}", 1)[-1] != "Bindings":
            raise ValueError(f"Invalid bindings root in {name}")
        for node in root.iter():
            if "file" in node.attrib:
                reference(name, node.attrib["file"])


def release_version(commit, files, tag):
    def json_at(name):
        return json.loads(git("show", f"{commit}:tools/witchcraft-daemon/{name}"))

    version = json_at("package.json")["version"]
    pattern = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
    if not isinstance(version, str) or not re.fullmatch(pattern, version):
        raise ValueError(f"Invalid daemon release version: {version}")
    lock = json_at("package-lock.json")
    if lock["version"] != version or lock["packages"][""]["version"] != version:
        raise ValueError("Daemon manifest and lockfile versions differ")
    toc = files["Witchcraft/Witchcraft.toc"].decode("utf-8-sig").splitlines()
    for field, expected in [("Version", version), ("X-Witchcraft-Build", f"release-{version}")]:
        values = [line.partition(":")[2].strip() for line in toc if line.startswith(f"## {field}:")]
        if values != [expected]:
            raise ValueError(f"Expected one TOC {field} equal to {expected}, found {values}")
    builds = re.findall(r'^local BUILD\s*=\s*"([^"]+)"\s*$', files["Witchcraft/Core.lua"].decode(), re.MULTILINE)
    if builds != [f"release-{version}"]:
        raise ValueError(f"Core BUILD does not match the daemon version {version}")
    if tag:
        if tag != f"v{version}" or git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}").decode().strip() != commit:
            raise ValueError(f"Tag {tag} must be v{version} on commit {commit}")
    return version


def write_candidate(path, files):
    # Stored entries make output independent of the machine's compression library.
    with zipfile.ZipFile(path, "w") as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])


def verify_zip(path, files):
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if sorted(entry.filename for entry in entries) != sorted(files):
            raise ValueError(f"{path} file list differs from the tagged addon tree")
        for entry in entries:
            expected = files[entry.filename]
            if entry.file_size != len(expected) or archive.read(entry) != expected:
                raise ValueError(f"{path} differs from Git at {entry.filename}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--tag", help="also require this release tag to match the ref and version")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--asset", type=Path, help="published ZIP to compare with the candidate")
    args = parser.parse_args()
    commit = git("rev-parse", "--verify", "--end-of-options", f"{args.ref}^{{commit}}").decode().strip()
    files = addon_files(commit)
    validate_load_paths(files)
    version = release_version(commit, files, args.tag)
    candidate = args.output_dir / f"Witchcraft-{version}.zip"
    if args.asset and args.asset.resolve() == candidate.resolve():
        raise ValueError("Use separate paths for the downloaded asset and generated candidate")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_candidate(candidate, files)
    digest = verify_zip(candidate, files)
    print(f"{digest}  {candidate} ({len(files)} files from {commit})")
    if args.asset:
        if verify_zip(args.asset, files) != digest:
            raise ValueError("Published ZIP contents match but its archive SHA-256 differs from the candidate")
        print(f"{digest}  {args.asset} (matches candidate)")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, ET.ParseError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        sys.exit(f"Release verification failed: {error}")
