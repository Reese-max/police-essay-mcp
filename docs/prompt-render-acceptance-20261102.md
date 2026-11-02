# Prompt release rendering acceptance

The final three original rendering tests (#30 Unicode separators, #32 wide ASCII, #34 distributed PDF/DOCX positioning) passed without skipped tests or weakened assertions. The integration includes main b55d886 (PR57 head 8403c96), whose latest Node20/22/24 CI run 41509576143 succeeded; its earlier failed run is not counted as evidence here.

The test-only KEEP_ISSUE_RENDER_ARTIFACTS option preserves actual exports for visual inspection. Wide-ASCII variants use separate filenames; all content assertions remain unchanged. Production layout, fonts, templates, codecs and stored schemas are unchanged relative to current main.

QA image sha256:6f07730e7358c01e50ecf52eb045792493fece1480ec23e4226db7dd5d750e7a derives from the existing pem:roundD image sha256:3ff74e4f0b4bf3a1f338f0a9c03d9460da5bd32706b2e3e6af4293d091e16d9f. The base is Debian 12; its inspected deb.debian.org bookworm/bookworm-updates/bookworm-security sources use the Debian archive keyring. Only the user-approved poppler-utils, libreoffice, python3 and their required package dependencies were installed inside the QA image. No host installation, credentials, production data or Docker socket were mounted. Test execution used network none and a read-only root filesystem with temporary writable test output.

Actual versions: Node24.21.0, Python3.11.2 (package 3.11.2-1+b1), LibreOffice4:7.4.7-1+deb12u14, Poppler22.12.0-2+deb12u3, fonts-noto-cjk1:20220127+repack1-1. Full dpkg manifest and build log are retained outside Git in prompt-review-20261101.

Integrated local typecheck/build passed. The integrated Windows full suite ran 360 tests: 353 pass, 0 fail, 7 platform skips. The final three Linux rendering tests then passed 3/3 with no skip. Earlier fixed-image Noto3/3 and real Firestore emulator1/1 evidence is retained separately; this is not a claim of a single 360/360 full-suite run. The pending PR CI must independently pass before release.

Actual native-PDF and LibreOffice-converted pages from the preserved Unicode/distribution tests were rendered and viewed, including the deliberately blank second sheets; no visible missing characters, clipping or overlap was observed. These general-template regression fixtures are not presented as the user's ideal 165 sample.

All four separate wide-ASCII PDFs were subsequently rendered and viewed (eight pages). Text is complete; the extreme consecutive m/W variants visibly extend slightly past the right grid boundary. The existing #32 assertion verifies text preservation, not grid containment. This warning is retained, not hidden by a weaker assertion or described as flawless visual acceptance. Exporters/layout/metrics have no diff against integrated main, and this release deliberately preserves their geometry. The issue is distinct from the 165 template and requires separate layout work.

The existing prompt-effect evidence remains limited (one win and three ties in the later comparison); this release does not guarantee higher scores. semantic/sourceVerification remain not_checked and callerNote is caller-reported evidence, not software semantic approval.
