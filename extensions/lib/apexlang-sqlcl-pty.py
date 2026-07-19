#!/usr/bin/env python3
"""Run one command behind a PTY and proxy bytes over stdin/stdout.

SQLcl waits for EOF when its stdin is a regular pipe.  A PTY keeps SQLcl in
interactive mode so the parent process can inspect validation output before it
sends the import command.  SQLcl stdout and stderr are intentionally merged by
the PTY into this process's stdout.
"""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3


def write_all(file_descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        try:
            written = os.write(file_descriptor, remaining)
        except InterruptedError:
            continue
        if written <= 0:
            raise BrokenPipeError("PTY proxy write returned no progress")
        remaining = remaining[written:]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: apexlang-sqlcl-pty.py COMMAND [ARG ...]", file=sys.stderr)
        return 2
    try:
        os.fstat(CONTROL_FD)
    except OSError:
        print("PTY proxy requires a private process-group control pipe", file=sys.stderr)
        return 2

    handled_signals = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    previous_signal_mask = signal.pthread_sigmask(signal.SIG_BLOCK, handled_signals)
    try:
        child_pid, master_fd = pty.fork()
    except BaseException:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)
        raise
    if child_pid == 0:
        # forkpty has completed login_tty()/setsid() before this branch runs,
        # so publishing our own PID proves that the process group now exists.
        try:
            write_all(CONTROL_FD, f"{os.getpid()}\n".encode("ascii"))
        except BaseException:
            os._exit(70)
        finally:
            os.close(CONTROL_FD)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    os.close(CONTROL_FD)

    def terminate_child_group(_signum: int, _frame: object) -> None:
        try:
            # forkpty makes the command a separate session/process-group
            # leader.  Force-killing that group prevents SQLcl or Java from
            # continuing an import after the Node caller has failed closed.
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            # The forkpty parent may return just before its child completes
            # login_tty()/setsid().  At that instant the future child process
            # group does not exist yet, but the child PID does and cannot have
            # spawned descendants.  Kill that PID to close the startup race.
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    for handled_signal in handled_signals:
        signal.signal(handled_signal, terminate_child_group)
    try:
        fcntl.ioctl(
            master_fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", 40, 120, 0, 0),
        )
        attributes = termios.tcgetattr(master_fd)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(master_fd, termios.TCSANOW, attributes)
    except BaseException:
        terminate_child_group(signal.SIGTERM, None)
        os.waitpid(child_pid, 0)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)
        raise
    signal.pthread_sigmask(signal.SIG_SETMASK, previous_signal_mask)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    child_status: int | None = None

    try:
        while True:
            watched_fds = [master_fd]
            if stdin_open:
                watched_fds.append(stdin_fd)
            try:
                readable, _, _ = select.select(watched_fds, [], [], 0.1)
            except InterruptedError:
                continue

            if master_fd in readable:
                try:
                    output = os.read(master_fd, 65536)
                except InterruptedError:
                    continue
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    output = b""
                if output:
                    write_all(stdout_fd, output)
                else:
                    break

            if stdin_open and stdin_fd in readable:
                command_bytes = os.read(stdin_fd, 65536)
                if command_bytes:
                    write_all(master_fd, command_bytes)
                else:
                    # Keep the PTY open until SQLcl processes the already-forwarded
                    # exit command and closes on its own.
                    stdin_open = False

    except BaseException:
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if child_status is None:
            os.waitpid(child_pid, 0)
        raise

    if child_status is None:
        _, child_status = os.waitpid(child_pid, 0)
    return os.waitstatus_to_exitcode(child_status)


if __name__ == "__main__":
    raise SystemExit(main())
