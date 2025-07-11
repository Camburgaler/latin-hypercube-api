import dotenv from "dotenv";
dotenv.config();

import {
    GITHUB_METADATA_HOST,
    GITHUB_METADATA_REPOS_PATH,
    GITHUB_USERNAME,
    LHC_VERSION,
    LhcArgs,
    REPO_NAME_LATIN_HYPERCUBE_GENERATOR,
} from "@camburgaler/latin-hypercube-shared";
import { spawn } from "child_process";
import fsSync, { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import os from "os";
import path from "path";
import tmp from "tmp-promise";

const GITHUB_METADATA_RELEASES_PATH = "/releases";
const GITHUB_HOST = "https://github.com";
const GITHUB_DOWNLOAD_PATH = "/download";
const isWindows = process.platform === "win32";
const LATIN_HYPERCUBE_GENERATOR_EXECUTABLE = isWindows ? "lhc.exe" : "lhc";
const LHC_DIRECTORY = "/lhc";

const allowedOrigins = ["https://www.camburgaler.com", "http://localhost:3000"];

function withCors(response: NextResponse, request: NextRequest): NextResponse {
    const origin =
        request.headers.get("Origin") ?? request.headers.get("origin");
    if (origin && allowedOrigins.includes(origin)) {
        response.headers.set("Access-Control-Allow-Origin", origin);
    }

    response.headers.set("Access-Control-Allow-Methods", "POST");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return response;
}

function constructLhcArgs(args: LhcArgs): string[] {
    const lhcArgs: string[] = [];

    lhcArgs.push("--number");
    lhcArgs.push(String(args.number));

    lhcArgs.push("--dimensions");
    lhcArgs.push(String(args.dimensions));

    if (args.random) {
        lhcArgs.push("--random");
        if (typeof args.random[0] === "number") {
            lhcArgs.push((args.random as number[]).join(","));
        } else {
            lhcArgs.push(args.random as string);
        }
    }

    if (args.base_scale) {
        lhcArgs.push("--base-scale");
        lhcArgs.push(
            String(args.base_scale.lower) + ":" + String(args.base_scale.upper)
        );
    }

    if (args.scales) {
        lhcArgs.push("--scales");
        let scaleString = "";
        for (const key in args.scales) {
            scaleString +=
                key +
                ":" +
                String(args.scales[key].lower) +
                ":" +
                String(args.scales[key].upper);
            if (Number(key) < Object.keys(args.scales).length - 1) {
                scaleString += ",";
            }
        }
        lhcArgs.push(scaleString);
    }

    if (args.column_headings) {
        lhcArgs.push("--column-headings");
        lhcArgs.push(args.column_headings.join(","));
    }

    return lhcArgs;
}

async function ensureExecutableDownloaded(
    executableUrl: string,
    localExecutablePath: string
) {
    try {
        // If the file already exists, return early
        console.log(`Checking if file exists: ${localExecutablePath}`);
        await fs.access(localExecutablePath, fs.constants.X_OK);
        if ((await fs.stat(localExecutablePath)).size === 0) {
            throw new Error("File is empty");
        }
    } catch {
        // Download and write the file
        const ghPat = process.env.GITHUB_PAT;

        console.log(`Downloading executable: ${executableUrl}`);
        const res = await fetch(
            executableUrl,
            ghPat
                ? {
                      headers: {
                          Authorization: `Bearer ${ghPat}`,
                      },
                  }
                : {}
        );
        if (!res.ok) {
            console.error(`Failed to download executable: ${res.status}`);
            throw new Error(`Failed to download executable: ${res.status}`);
        }

        console.log(`Writing file: ${localExecutablePath}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const chunks: Uint8Array[] = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }

        const fullBuffer = Buffer.concat(chunks);
        await fs.writeFile(localExecutablePath, fullBuffer);

        // Make it executable
        console.log(`Making file executable: ${localExecutablePath}`);
        await fsSync.chmodSync(localExecutablePath, 0o755);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // delay to release lock on file
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    console.log("Received request");
    const body: LhcArgs = await req.json();
    console.log(body);

    // input validation for lhc args
    // number must be greater than 0
    if (body.number < 0) {
        return withCors(
            NextResponse.json(
                { message: "number must be greater than 0" },
                { status: 400 }
            ),
            req
        );
    }
    // dimensions must be greater than 0
    if (body.dimensions < 0) {
        return withCors(
            NextResponse.json(
                { message: "dimensions must be greater than 0" },
                { status: 400 }
            ),
            req
        );
    }
    if (body.random && body.random[0]) {
        // random must not have a length longer than dimensions
        if (body.random.length > body.dimensions) {
            return withCors(
                NextResponse.json(
                    {
                        message:
                            "random must not have a length longer than dimensions",
                    },
                    { status: 400 }
                ),
                req
            );
        }
        for (const r of body.random) {
            // random must be between 0 and dimensions
            const rAsNumber = Number(r);
            if (rAsNumber < 0 || rAsNumber > body.dimensions) {
                return withCors(
                    NextResponse.json(
                        { message: "random must be between 0 and dimensions" },
                        { status: 400 }
                    ),
                    req
                );
            }
        }
    }
    if (body.scales) {
        // scales must not have a length longer than dimensions
        if (Object.keys(body.scales).length > body.dimensions) {
            return withCors(
                NextResponse.json(
                    {
                        message:
                            "scales must not have a length longer than dimensions",
                    },
                    { status: 400 }
                ),
                req
            );
        }
        for (const s of Object.keys(body.scales)) {
            // scales must be between 0 and dimensions
            const sAsNumber = Number(s);
            if (sAsNumber < 0 || sAsNumber > body.dimensions) {
                return withCors(
                    NextResponse.json(
                        { message: "scales must be between 0 and dimensions" },
                        { status: 400 }
                    ),
                    req
                );
            }
        }
    }
    if (body.column_headings) {
        // column_headings must have a length equal to dimensions
        if (body.column_headings.length !== body.dimensions) {
            return withCors(
                NextResponse.json(
                    {
                        message:
                            "column_headings must have a length equal to dimensions",
                    },
                    { status: 400 }
                ),
                req
            );
        }
    }

    // Create a temp file path
    console.log("Creating temp file");
    const { path: outputPath, cleanup } = await tmp.file({ postfix: ".csv" });

    // get all releases
    const lhcReleasesUrl = `${GITHUB_METADATA_HOST}${GITHUB_METADATA_REPOS_PATH}/${GITHUB_USERNAME}/${REPO_NAME_LATIN_HYPERCUBE_GENERATOR}${GITHUB_METADATA_RELEASES_PATH}`;
    console.log("Getting LHC Releases: " + lhcReleasesUrl);

    const lhcReleasesRes = await fetch(
        lhcReleasesUrl,
        process.env.GITHUB_PAT
            ? {
                  headers: {
                      Authorization: `Bearer ${process.env.GITHUB_PAT}`,
                  },
              }
            : {}
    );

    if (!lhcReleasesRes.ok) {
        return withCors(
            NextResponse.json(
                { message: "LHC Releases: " + lhcReleasesRes.statusText },
                { status: lhcReleasesRes.status }
            ),
            req
        );
    }

    const lhcReleases = (await lhcReleasesRes.json()) as Record<
        string,
        unknown
    >[];

    // get latest release
    const latestRelease: string = lhcReleases.find(
        (r: Record<string, unknown>) =>
            (r.tag_name as string).startsWith(LHC_VERSION)
    )!.tag_name as string;
    console.log("Latest LHC Release: " + latestRelease);

    // get asset
    const lhcExecutableUrl = `${GITHUB_HOST}/${GITHUB_USERNAME}/${REPO_NAME_LATIN_HYPERCUBE_GENERATOR}${GITHUB_METADATA_RELEASES_PATH}${GITHUB_DOWNLOAD_PATH}/${latestRelease}/${LATIN_HYPERCUBE_GENERATOR_EXECUTABLE}`;

    const localExecutablePath = path.join(
        os.tmpdir(),
        LHC_DIRECTORY,
        latestRelease,
        LATIN_HYPERCUBE_GENERATOR_EXECUTABLE
    );
    await fs.mkdir(path.dirname(localExecutablePath), { recursive: true });

    try {
        await ensureExecutableDownloaded(lhcExecutableUrl, localExecutablePath);
    } catch (e) {
        const err = e as Error;
        return withCors(
            NextResponse.json(
                { error: `Download error: ${err.message}` },
                { status: 500 }
            ),
            req
        );
    }

    return new Promise((resolve) => {
        // run executable with CLI args from request body
        console.log(
            "Running LHC:",
            localExecutablePath,
            ...constructLhcArgs(body),
            "--out-path",
            outputPath
        );
        const lhcProcess = spawn(
            localExecutablePath,
            [...constructLhcArgs(body), "--out-path", outputPath],
            {}
        );

        lhcProcess.stdout.on("data", (data) => {
            console.log(`stdout: ${data}`);
        });

        lhcProcess.stderr.on("data", (data) => {
            console.error(`stderr: ${data}`);
        });
        lhcProcess.on("error", (e) => {
            const err = e as Error;
            console.error(err);
            cleanup();
            resolve(
                withCors(
                    NextResponse.json(
                        { error: `Execution error: ${err.message}` },
                        { status: 500 }
                    ),
                    req
                )
            );
        });
        lhcProcess.on("close", async (code) => {
            console.log(`LHC exited with code ${code}`);
            if (code !== 0) {
                cleanup();
                return resolve(
                    withCors(
                        NextResponse.json(
                            { error: `Exited with code ${code}` },
                            { status: 500 }
                        ),
                        req
                    )
                );
            }

            try {
                console.log(`Reading file: ${outputPath}`);
                const csvContents = await fs.readFile(outputPath, "utf-8");
                cleanup();
                resolve(
                    withCors(
                        NextResponse.json({
                            csv: csvContents,
                            version: latestRelease,
                        }),
                        req
                    )
                );
            } catch (e) {
                const err = e as Error;
                console.error(err);
                cleanup();
                resolve(
                    withCors(
                        NextResponse.json(
                            { error: `Read error: ${err.message}` },
                            { status: 500 }
                        ),
                        req
                    )
                );
            }
        });
    });
}
