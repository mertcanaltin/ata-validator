#!/usr/bin/env python3
#
# Creates the amalgamated source files for ata-validator.
# Based on ada's amalgamate.py pattern.
#

import sys
import os
import re
import subprocess
import datetime
import shutil

if sys.version_info[0] < 3:
    sys.stdout.write('Sorry, requires Python 3.x or better\n')
    sys.exit(1)

SCRIPT_PATH = os.path.dirname(os.path.abspath(sys.argv[0]))
PROJECT_PATH = os.path.dirname(SCRIPT_PATH)

AMALGAMATE_SOURCE_PATH = os.environ.get('AMALGAMATE_SOURCE_PATH') or os.path.join(PROJECT_PATH, 'src')
AMALGAMATE_INCLUDE_PATH = os.environ.get('AMALGAMATE_INPUT_PATH') or os.path.join(PROJECT_PATH, 'include')
AMALGAMATE_OUTPUT_PATH = os.environ.get('AMALGAMATE_OUTPUT_PATH') or SCRIPT_PATH

ALL_C_FILES = ['ata.cpp']
ALL_C_HEADERS = ['ata.h']

found_includes = []


def doinclude(fid, file, line, origin):
    p = os.path.join(AMALGAMATE_INCLUDE_PATH, file)
    pi = os.path.join(AMALGAMATE_SOURCE_PATH, file)

    if os.path.exists(p):
        if file not in found_includes:
            found_includes.append(file)
            dofile(fid, AMALGAMATE_INCLUDE_PATH, file)
    elif os.path.exists(pi):
        if file not in found_includes:
            found_includes.append(file)
            dofile(fid, AMALGAMATE_SOURCE_PATH, file)
    else:
        print(line, file=fid)


def dofile(fid, prepath, filename):
    file = os.path.join(prepath, filename)
    RELFILE = os.path.relpath(file, PROJECT_PATH)
    print(f'/* begin file {RELFILE} */', file=fid)
    includepattern = re.compile(r'\s*#\s*include "(.*)"')
    with open(file, 'r') as fid2:
        for line in fid2:
            line = line.rstrip('\n')
            s = includepattern.search(line)
            if s:
                includedfile = s.group(1)
                # keep ata.h include in ata.cpp
                if includedfile == 'ata.h' and filename == 'ata.cpp':
                    print(line, file=fid)
                    continue
                doinclude(fid, includedfile, line, filename)
            else:
                print(line, file=fid)
    print(f'/* end file {RELFILE} */', file=fid)


try:
    timestamp = (
        subprocess.run(['git', 'show', '-s', '--format=%ci', 'HEAD'], stdout=subprocess.PIPE)
        .stdout.decode('utf-8')
        .strip()
    )
except Exception:
    timestamp = str(datetime.datetime.now())

print(f'timestamp is {timestamp}')

os.makedirs(AMALGAMATE_OUTPUT_PATH, exist_ok=True)
AMAL_H = os.path.join(AMALGAMATE_OUTPUT_PATH, 'ata.h')
AMAL_C = os.path.join(AMALGAMATE_OUTPUT_PATH, 'ata.cpp')

print(f'Creating {AMAL_H}')
with open(AMAL_H, mode='w', encoding='utf8') as amal_h:
    print(f'/* auto-generated on {timestamp}. Do not edit! */', file=amal_h)
    for h in ALL_C_HEADERS:
        doinclude(amal_h, h, f'ERROR {h} not found', h)

print(f'Creating {AMAL_C}')
found_includes = []
with open(AMAL_C, mode='w', encoding='utf8') as amal_c:
    print(f'/* auto-generated on {timestamp}. Do not edit! */', file=amal_c)
    for c in ALL_C_FILES:
        doinclude(amal_c, c, f'ERROR {c} not found', c)

print(f'Files have been written to directory: {AMALGAMATE_OUTPUT_PATH}/')
print('Done with all files generation.')
