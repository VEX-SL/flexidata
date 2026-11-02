export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useTranslation();
  const [user, setUser] = useState<any>(null);

  // Delete account state
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        setUser(user);
        setEmail(user.email || "");

        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("name, avatar_url")
            .eq("id", user.id)
            .maybeSingle();

          if (profile) {
            if (profile.name) setName(profile.name);
            if (profile.avatar_url) setAvatarPreview(profile.avatar_url);
          }
        } catch {}
      }
    });
  }, [supabase]);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    if (!user) {
      setLoading(false);
      return;
    }

    // Update name in profiles table
    if (name) {
      const { error: nameError } = await supabase
        .from('profiles')
        .upsert({ id: user.id, name }, { onConflict: 'id' });
      if (nameError) {
        setError(nameError.message);
        setLoading(false);
        return;
      }
    }

    // Handle avatar upload if provided
    if (avatar) {
      try {
        // Delete old avatar from storage if exists
        const { data: oldProfile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', user.id)
          .maybeSingle();

        if (oldProfile?.avatar_url) {
          const oldFileName = oldProfile.avatar_url.split('/').pop();
          if (oldFileName && oldFileName.includes('.')) {
            await supabase.storage.from('avatars').remove([oldFileName]);
          }
        }

        const fileName = `${user.id}-${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, avatar, { cacheControl: '3600', upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        // Update profile with avatar URL
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ avatar_url: publicUrl })
          .eq('id', user.id);

        if (profileError) throw profileError;

        // Reload profile data to update preview immediately
        const { data: updatedProfile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', user.id)
          .single();
        
        setAvatarPreview(updatedProfile?.avatar_url || null);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "فشل رفع الصورة. يرجى المحاولة مرة أخرى.");
        setLoading(false);
        return;
      }
    }
    // Handle avatar removal
    else if (avatar === null && avatarPreview === null) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', user.id)
        .maybeSingle();

      if (profile?.avatar_url) {
        const fileName = profile.avatar_url.split('/').pop();
        if (fileName && fileName.includes('.')) {
          await supabase.storage.from('avatars').remove([fileName]);
        }
        await supabase.from('profiles').update({ avatar_url: null }).eq('id', user.id);
      }
    }

    setSuccess(t('settings.saved'));
    setLoading(false);
  }

  // Rest of the component code...

  return (
    <div className="fd-scroll h-full overflow-y-auto p-6">
      {/* Component content */}
    </div>
  );
}